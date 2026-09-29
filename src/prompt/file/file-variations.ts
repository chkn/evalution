// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import path from "node:path";
import type { FileProvider } from "../../file-provider.ts";
import { OverlayFileProvider } from "../../file-provider-overlay.ts";
import { shortId, versionLabel } from "../../shared/helpers.ts";
import type {
  ConflictChoices,
  NormalizedPromptUpdates,
  PromptChangeEvent,
  PromptRef,
  RebaseResult,
  VariationConflict,
  VariationId,
  VariationInfo,
  VersionId,
  VersionInfo,
} from "../../shared/types.ts";
import {
  type OpenOnHeadOptions,
  type PromptRefLike,
  type PromptVariations,
  type PromptVersions,
  toPromptRef,
  VariationConflictError,
} from "../prompt-provider.ts";
import {
  canonicalizeUpdates,
  fieldUpdatesOf,
  isEmptyUpdates,
  mergeUpdates,
} from "../variations/canonical-updates.ts";
import {
  type MergeOutcome,
  mergeIntoWip,
  rebaseUpdates,
  resolveConflicts,
} from "../variations/rebase.ts";
import type {
  StoredVariation,
  VariationStore,
} from "../variations/variation-store.ts";
import type { VersioningAdapter } from "../versioning/versioning-adapter.ts";
import type {
  NormalizedFilePrompt,
  PromptFileType,
} from "./prompt-file-type.ts";

/** How many parsed versions and materialized variations are kept. */
const MATERIALIZED_CACHE_SIZE = 64;

/** Normalize fields only: see {@link FileVariationsHost.normalizeWith}. */
const FIELDS = { resolveTypes: false };

/** Labels for the two sides of a conflict an external edit caused. */
const REBASE_LABELS = { target: "working tree", variation: "unsaved edits" };

/**
 * What {@link FileVariations} needs from the {@link FilePromptProvider} it
 * serves — parsing, editing and file access — without owning any of it.
 */
export interface FileVariationsHost {
  readonly rootDir: string;
  readonly fileProvider: FileProvider;
  readonly fileType: PromptFileType;
  /** `[absolutePath, promptName]` for a prompt id. */
  parsePromptId(id: string): [string, string];
  /** Every prompt at head, as parsed from disk. */
  parseAll(): Promise<NormalizedFilePrompt[]>;
  /**
   * Normalizes `files` through `fileType` — the head one, or a materializer.
   * With `resolveTypes: false`, only the fields: no execute parameters or
   * input sources, and a fraction of the cost.
   */
  normalizeWith(
    fileType: PromptFileType,
    files: string[],
    options?: { resolveTypes?: boolean },
  ): Promise<NormalizedFilePrompt[]>;
  /** Writes `updates` into a prompt's source through `fileType`. */
  applyUpdates(
    fileType: PromptFileType,
    filePath: string,
    promptName: string,
    promptId: string,
    updates: NormalizedPromptUpdates,
  ): Promise<void>;
  /** Runs `mutate` once every earlier mutation of `filePath` has settled. */
  mutateFile<T>(filePath: string, mutate: () => Promise<T>): Promise<T>;
  /** Tells watchers a prompt changed. */
  emit(event: PromptChangeEvent): void;
}

/** A variation's source with its updates applied, and the prompt it parses to. */
interface Materialized {
  source: string;
  prompt: NormalizedFilePrompt;
}

/** A simple bounded map: the oldest entry goes when it's full. */
class BoundedCache<V> {
  private map = new Map<string, V>();
  private readonly size: number;
  constructor(size: number) {
    this.size = size;
  }
  get(key: string): V | undefined {
    return this.map.get(key);
  }
  set(key: string, value: V): V {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.size) {
      this.map.delete(this.map.keys().next().value!);
    }
    return value;
  }
  delete(key: string): void {
    this.map.delete(key);
  }
}

/** The public face of a stored variation. */
function toInfo(v: StoredVariation): VariationInfo {
  const { globalId: _, ...info } = v;
  return info;
}

/**
 * Versions and variations for a {@link FilePromptProvider}: it pins versions
 * through a {@link VersioningAdapter}, keeps variations in a
 * {@link VariationStore}, and materializes them — parsing and running a
 * variation's patched source — through an {@link OverlayFileProvider}, so
 * nothing but an explicit save ever writes a prompt file.
 *
 * See `specs/prompt-versions-and-variations.md` §C–§H.
 */
export class FileVariations {
  /** A file's content at a version. Versions are immutable, so this never goes stale. */
  private contents = new BoundedCache<Promise<string | undefined>>(
    MATERIALIZED_CACHE_SIZE * 4,
  );
  /** Prompts parsed at versions that aren't head. */
  private versionPrompts = new BoundedCache<
    Promise<NormalizedFilePrompt | undefined>
  >(MATERIALIZED_CACHE_SIZE);
  /** Materialized variations, keyed by id and last change. */
  private materialized = new BoundedCache<Promise<Materialized>>(
    MATERIALIZED_CACHE_SIZE,
  );

  /** Head prompts with their types resolved, by id, with the content they were read from. */
  private headTypesCache = new Map<
    string,
    { content: string; prompt: NormalizedFilePrompt }
  >();

  /** The one overlay every materialization goes through, one at a time. */
  private overlay?: OverlayFileProvider;
  private overlayFileType?: PromptFileType;
  private overlayLock: Promise<unknown> = Promise.resolve();

  /** Tail of the WIP mutation chain per prompt, as `FilePromptProvider.mutateFile`. */
  private wipLocks = new Map<string, Promise<void>>();

  private readonly host: FileVariationsHost;
  /** How versions are named. */
  readonly versioning: VersioningAdapter;
  /** Where variations are kept; without one, there are versions but no variations. */
  readonly store: VariationStore | undefined;

  constructor(
    host: FileVariationsHost,
    versioning: VersioningAdapter,
    store: VariationStore | undefined,
  ) {
    this.host = host;
    this.versioning = versioning;
    this.store = store;
  }

  // ── Paths and content ─────────────────────────────────────────────────────

  private relativePath(filePath: string): string {
    return path.relative(this.host.rootDir, filePath).split(path.sep).join("/");
  }

  private relativePathOf(promptId: string): string {
    return this.relativePath(this.host.parsePromptId(promptId)[0]);
  }

  /** `filePath`'s content at `version`, or `undefined` if it didn't exist there. */
  private contentAt(
    version: VersionId,
    filePath: string,
  ): Promise<string | undefined> {
    const rel = this.relativePath(filePath);
    const key = `${version}\0${rel}`;
    const cached = this.contents.get(key);
    if (cached) return cached;
    const read = this.versioning.readFile(version, rel);
    // A failed read isn't a fact about the version; don't keep it.
    read.catch(() => this.contents.delete(key));
    return this.contents.set(key, read);
  }

  private async diskContent(filePath: string): Promise<string | undefined> {
    return this.host.fileProvider.readFile(filePath).catch(() => undefined);
  }

  /** Whether `filePath` at `version` is what's on disk now. */
  private async isHeadContent(
    version: VersionId,
    filePath: string,
  ): Promise<boolean> {
    const [atVersion, onDisk] = await Promise.all([
      this.contentAt(version, filePath),
      this.diskContent(filePath),
    ]);
    return atVersion !== undefined && atVersion === onDisk;
  }

  /** Pins head as a version, for the file `filePath`. */
  snapshotFor(filePath: string): Promise<VersionInfo> {
    return this.versioning.snapshot(this.relativePath(filePath));
  }

  /** Forgets memoized state that something on disk may have changed. */
  invalidate(): void {
    this.versioning.invalidate?.();
    // Types depend on more than the prompt's own file — its playground
    // modules, chiefly — so a change anywhere retires them.
    this.headTypesCache.clear();
  }

  private requireStore(): VariationStore {
    if (!this.store) {
      throw new Error("This prompt provider has no variation store");
    }
    return this.store;
  }

  // ── Materialization ───────────────────────────────────────────────────────

  /**
   * Runs `use` with the overlay holding `content` at `filePath`, one at a
   * time: the overlay is shared, so two materializations must not interleave.
   */
  private withOverlay<T>(
    filePath: string,
    content: string,
    use: (fileType: PromptFileType, overlay: OverlayFileProvider) => Promise<T>,
  ): Promise<T> {
    const run = async () => {
      if (!this.overlay) {
        if (!this.host.fileType.withFileProvider) {
          throw new Error(
            "This prompt file type can't show or run variations: it has no " +
              "`withFileProvider`",
          );
        }
        this.overlay = new OverlayFileProvider(this.host.fileProvider);
        this.overlayFileType = this.host.fileType.withFileProvider(
          this.overlay,
        );
      }
      this.overlay.set(filePath, content);
      try {
        return await use(this.overlayFileType!, this.overlay);
      } finally {
        this.overlay.clear();
      }
    };
    const result = this.overlayLock.then(run, run);
    this.overlayLock = result.catch(() => {});
    return result;
  }

  /**
   * The prompt `promptId` as it was at `version`, unannotated, or `undefined`
   * when it didn't exist there. Parsed through the overlay unless the file is
   * unchanged since, in which case head's own parse is it.
   *
   * Fields only — no execute parameters or input sources: merging needs only
   * the fields, and an old version can't run, so resolving its types (most
   * of what a read costs) would buy nothing.
   */
  async promptAtVersion(
    version: VersionId,
    promptId: string,
  ): Promise<NormalizedFilePrompt | undefined> {
    const [filePath, name] = this.host.parsePromptId(promptId);
    const content = await this.contentAt(version, filePath);
    if (content === undefined) return undefined;
    if (content === (await this.diskContent(filePath))) {
      return (
        await this.host.normalizeWith(this.host.fileType, [filePath], FIELDS)
      ).find(p => p.name === name);
    }
    const key = `${version}\0${promptId}`;
    const cached = this.versionPrompts.get(key);
    if (cached) return cached;
    const parsed = this.withOverlay(filePath, content, async fileType =>
      (await this.host.normalizeWith(fileType, [filePath], FIELDS)).find(
        p => p.name === name,
      ),
    );
    parsed.catch(() => this.versionPrompts.delete(key));
    return this.versionPrompts.set(key, parsed);
  }

  /**
   * A variation's source — its base content with its updates applied through
   * the ordinary edit pipeline — and the prompt it parses to, fields only.
   * See {@link withHeadTypes} for the rest.
   */
  private materialize(v: StoredVariation): Promise<Materialized> {
    const key = `${v.id}\0${v.updatedAt}`;
    const cached = this.materialized.get(key);
    if (cached) return cached;

    const [filePath, name] = this.host.parsePromptId(v.promptId);
    const result = (async () => {
      const content = await this.contentAt(v.base, filePath);
      if (content === undefined) {
        throw new Error(
          `Can't read ${this.relativePath(filePath)} at version ${v.base}`,
        );
      }
      return this.withOverlay(filePath, content, async (fileType, overlay) => {
        if (!isEmptyUpdates(v.updates)) {
          await this.host.applyUpdates(
            fileType,
            filePath,
            name,
            v.promptId,
            v.updates,
          );
        }
        const prompt = (
          await this.host.normalizeWith(fileType, [filePath], FIELDS)
        ).find(p => p.name === name);
        if (!prompt) throw new Error("Prompt not found");
        return { source: overlay.get(filePath) ?? content, prompt };
      });
    })();
    result.catch(() => this.materialized.delete(key));
    return this.materialized.set(key, result);
  }

  /**
   * Loads a variation's config for running: imports its patched source as
   * though it were the real file, so its imports resolve against head's code.
   */
  async loadConfig(v: StoredVariation, params: any[]): Promise<any> {
    const { source } = await this.materialize(v);
    const [filePath, name] = this.host.parsePromptId(v.promptId);
    return this.withOverlay(filePath, source, fileType =>
      fileType.loadConfig(filePath, name, params),
    );
  }

  // ── Reading refs ──────────────────────────────────────────────────────────

  /** Adds what the client needs to know about head to a head prompt. */
  annotateHead(
    prompt: NormalizedFilePrompt,
    wip?: StoredVariation,
  ): NormalizedFilePrompt {
    return {
      ...prompt,
      ref: { promptId: prompt.id },
      atHead: true,
      ...(wip && { dirty: true, wipId: wip.id }),
    };
  }

  /** Annotates every head prompt with whether it has unsaved edits. */
  async annotateAll(
    prompts: NormalizedFilePrompt[],
  ): Promise<NormalizedFilePrompt[]> {
    const wips = new Map(
      ((await this.store?.listHeadWips()) ?? []).map(w => [w.promptId, w]),
    );
    return prompts.map(p => this.annotateHead(p, wips.get(p.id)));
  }

  /** The head prompt, annotated, with any unsaved edits rebased first. */
  async headPrompt(promptId: string): Promise<NormalizedFilePrompt | null> {
    const wip = await this.withWipLock(promptId, () =>
      this.currentHeadWip(promptId),
    );
    const prompt = await this.headTypes(promptId);
    return prompt ? this.annotateHead(prompt, wip) : null;
  }

  /**
   * The head prompt, fully normalized — its types resolved — and kept until
   * its file or a playground module changes, so the variations on head can
   * borrow its types instead of resolving their own (see
   * {@link withHeadTypes}).
   */
  private async headTypes(
    promptId: string,
  ): Promise<NormalizedFilePrompt | undefined> {
    const [filePath, name] = this.host.parsePromptId(promptId);
    const content = await this.diskContent(filePath);
    const cached = this.headTypesCache.get(promptId);
    if (cached && cached.content === content) return cached.prompt;
    const prompt = (
      await this.host
        .normalizeWith(this.host.fileType, [filePath])
        .catch(() => [])
    ).find(p => p.name === name);
    if (prompt && content !== undefined) {
      this.headTypesCache.set(promptId, { content, prompt });
    }
    return prompt;
  }

  /**
   * `prompt` — a variation on head, parsed fields-only — with head's resolved
   * types: its execute parameters, input sources and layout. A variation
   * changes only fields (model, system, messages, parameters), none of which
   * those are derived from, so head's answers are its answers — without the
   * program build that re-deriving them would cost on every edit.
   */
  private async withHeadTypes(
    prompt: NormalizedFilePrompt,
  ): Promise<NormalizedFilePrompt> {
    const head = await this.headTypes(prompt.id);
    if (!head) return prompt;
    const { executeParameters, inputSources, inputLayout } = head;
    return {
      ...prompt,
      ...(executeParameters && { executeParameters }),
      ...(inputSources && { inputSources }),
      ...(inputLayout && { inputLayout }),
    };
  }

  /** The prompt `ref` names. */
  async getPrompt(ref: PromptRefLike): Promise<NormalizedFilePrompt | null> {
    const r = toPromptRef(ref);
    if (r.variation !== undefined) return this.variationPrompt(r.variation);
    if (r.version !== undefined)
      return this.versionPrompt(r.promptId, r.version);
    return this.headPrompt(r.promptId);
  }

  /**
   * The prompt at `version`. When that's what's on disk now, it's head — so
   * opening a trace just run lands somewhere editable.
   */
  private async versionPrompt(
    promptId: string,
    version: VersionId,
  ): Promise<NormalizedFilePrompt | null> {
    const [filePath] = this.host.parsePromptId(promptId);
    if (await this.isHeadContent(version, filePath)) {
      return this.headPrompt(promptId);
    }
    const [prompt, info, wip] = await Promise.all([
      this.promptAtVersion(version, promptId).catch(() => undefined),
      this.versioning.get(version),
      this.store?.getHeadWip(promptId),
    ]);
    if (!prompt) return null;
    return {
      ...prompt,
      ref: { promptId, version },
      ...(info && { version: info }),
      atHead: false,
      ...(wip && { dirty: true, wipId: wip.id }),
    };
  }

  private async variationPrompt(
    id: VariationId,
  ): Promise<NormalizedFilePrompt | null> {
    let v = await this.store?.get(id);
    if (!v) return null;
    if (v.wip && v.onHead) {
      // Head may have moved under the unsaved edits since: rebase them first.
      const promptId = v.promptId;
      const current = await this.withWipLock(promptId, () =>
        this.currentHeadWip(promptId),
      );
      // Rebased down to nothing: the edits were already made on disk.
      if (current?.id !== id) return this.headPrompt(promptId);
      v = current;
    }
    const [filePath] = this.host.parsePromptId(v.promptId);
    const [{ prompt }, info, atHead, wip] = await Promise.all([
      this.materialize(v),
      this.versioning.get(v.base),
      v.wip
        ? Promise.resolve(!!v.onHead)
        : this.isHeadContent(v.base, filePath),
      v.wip && v.onHead
        ? Promise.resolve(v)
        : this.store?.getHeadWip(v.promptId),
    ]);
    return {
      ...(atHead ? await this.withHeadTypes(prompt) : prompt),
      ref: { promptId: v.promptId, variation: id },
      ...(info && { version: info }),
      variation: toInfo(v),
      atHead,
      ...(wip && { dirty: true, wipId: wip.id }),
    };
  }

  // ── WIPs ──────────────────────────────────────────────────────────────────

  /**
   * Runs `fn` once every earlier WIP mutation of `promptId` has settled, so
   * rapid edits, a save and an external-edit rebase never interleave.
   */
  private withWipLock<T>(promptId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.wipLocks.get(promptId) ?? Promise.resolve();
    const result = previous.then(fn, fn);
    const settled = result.then(
      () => {},
      () => {},
    );
    this.wipLocks.set(promptId, settled);
    settled.then(() => {
      if (this.wipLocks.get(promptId) === settled)
        this.wipLocks.delete(promptId);
    });
    return result;
  }

  /**
   * Runs `fn` on variation `id` under its prompt's WIP lock, with the
   * variation as it stands once the lock is held — so acting on it never
   * undoes a mutation queued ahead, like an edit still landing when a save
   * arrives.
   *
   * @param wip - Require a WIP: a frozen variation, or none, is an error.
   */
  private async withVariation<T>(
    id: VariationId,
    fn: (v: StoredVariation) => Promise<T>,
    { wip = false }: { wip?: boolean } = {},
  ): Promise<T> {
    const store = this.requireStore();
    const read = async () => {
      const v = await store.get(id);
      if (!v || (wip && !v.wip)) {
        throw new Error(`No ${wip ? "WIP " : ""}variation ${id}`);
      }
      return v;
    };
    // A variation's prompt id never changes, so the lock found is the lock.
    const { promptId } = await read();
    return this.withWipLock(promptId, async () => fn(await read()));
  }

  /**
   * The prompt's head WIP, rebased onto head first if the file changed under
   * it since — whether the watcher saw the change or it happened while the
   * server was down. A clean rebase is silent; a conflicted one leaves the
   * WIP with pending conflicts. Call with the WIP lock held.
   */
  private async currentHeadWip(
    promptId: string,
  ): Promise<StoredVariation | undefined> {
    const wip = await this.store?.getHeadWip(promptId);
    if (!wip) return undefined;
    const [filePath] = this.host.parsePromptId(promptId);
    // Settled against head already: up to date.
    const settledOn = wip.pending ? wip.pending.onto : wip.base;
    if (await this.isHeadContent(settledOn, filePath)) return wip;
    if (!(await this.diskContent(filePath))) return wip; // file gone; leave it be

    const head = await this.snapshotFor(filePath);
    const outcome = await this.rebaseOnto(wip, head.id);
    const store = this.requireStore();
    if (outcome.ok) {
      if (isEmptyUpdates(outcome.updates)) {
        await store.deleteWip(wip.id);
        return undefined;
      }
      return store.updateWip(wip.id, {
        base: head.id,
        updates: outcome.updates,
        pending: null,
      });
    }
    return store.updateWip(wip.id, {
      pending: {
        onto: head.id,
        updates: outcome.updates,
        conflicts: outcome.conflicts,
        labels: REBASE_LABELS,
      },
    });
  }

  /**
   * Where `v`'s prompt lives at head: its own file while that still exists,
   * else wherever its `prompts()` id is now — a file move. The head version
   * has to be pinned for that file, which matters when a version is one file.
   */
  private async headLocation(
    v: StoredVariation,
  ): Promise<{ promptId: string; filePath: string }> {
    const [filePath] = this.host.parsePromptId(v.promptId);
    if ((await this.diskContent(filePath)) !== undefined || !v.globalId) {
      return { promptId: v.promptId, filePath };
    }
    const moved = (await this.host.parseAll()).find(
      p => p.globalId === v.globalId,
    );
    return moved
      ? { promptId: moved.id, filePath: this.host.parsePromptId(moved.id)[0] }
      : { promptId: v.promptId, filePath };
  }

  /**
   * Re-expresses `v` against `target` (§F), finding the prompt there by its id,
   * then — at head — by its `prompts()` id, so a rename doesn't lose it.
   */
  private async rebaseOnto(
    v: StoredVariation,
    target: VersionId,
    targetPromptId?: string,
  ): Promise<MergeOutcome & { promptId: string }> {
    const base = await this.promptAtVersion(v.base, v.promptId);
    if (!base) {
      throw new Error(`Can't read ${v.promptId} at version ${v.base}`);
    }
    let found = await this.promptAtVersion(
      target,
      targetPromptId ?? v.promptId,
    ).catch(() => undefined);
    if (!found && v.globalId) {
      const all = await this.host.parseAll();
      const candidate = all.find(p => p.globalId === v.globalId);
      const [candidatePath] = candidate
        ? this.host.parsePromptId(candidate.id)
        : [];
      if (candidatePath && (await this.isHeadContent(target, candidatePath))) {
        found = candidate;
      }
    }
    const outcome = rebaseUpdates(base, found, v.updates);
    return { ...outcome, promptId: found?.id ?? v.promptId };
  }

  /** Updates a prompt at `ref` — see `FilePromptProvider.updatePromptProperties`. */
  async update(
    ref: PromptRefLike,
    updates: NormalizedPromptUpdates,
  ): Promise<{ prompt: NormalizedFilePrompt; ref: PromptRef }> {
    const store = this.requireStore();
    const r = toPromptRef(ref);
    const source =
      r.variation !== undefined ? await store.get(r.variation) : undefined;
    if (r.variation !== undefined && !source) {
      throw new Error(`No variation ${r.variation}`);
    }
    // A saved variation is read-only: editing one would have to decide where
    // the edit lands — which, at head, means over any unsaved edits there.
    // Opening it on the working tree makes that an explicit, reviewed step.
    if (source && !source.wip) {
      throw new Error(
        "A saved variation can't be edited. Open it on the working tree to edit it.",
      );
    }
    const promptId = source?.promptId ?? r.promptId;
    const [filePath] = this.host.parsePromptId(promptId);

    const landed = await this.withWipLock(promptId, async () => {
      // Which WIP this edit lands in: its base, whether it's head's, and
      // what it already holds.
      let base: VersionId | undefined;
      let onHead: boolean;
      let existing: StoredVariation | undefined;

      // Re-read under the lock: a save or discard queued ahead of this edit
      // may have changed or deleted the WIP since it was looked up.
      const current = source?.wip ? await store.get(source.id) : undefined;
      if (current) {
        existing = current;
        base = current.base;
        onHead = !!current.onHead;
      } else {
        // A WIP that's gone lands the edit where it stood: at head, or at the
        // old version it was based on.
        const version = source
          ? source.onHead
            ? undefined
            : source.base
          : r.version;
        if (
          version !== undefined &&
          !(await this.isHeadContent(version, filePath))
        ) {
          onHead = false;
          base = version;
          existing = await store.getWip(promptId, base);
        } else {
          onHead = true;
          existing = await this.currentHeadWip(promptId);
          base = existing?.base;
        }
      }

      if (existing?.pending) {
        throw new VariationConflictError(existing.pending.conflicts);
      }
      base ??= (await this.snapshotFor(filePath)).id;

      const basePrompt = await this.promptAtVersion(base, promptId);
      if (!basePrompt) throw new Error("Prompt not found");
      const canonical = canonicalizeUpdates(
        basePrompt,
        mergeUpdates(existing?.updates, updates),
      );

      if (isEmptyUpdates(canonical)) {
        if (existing) await store.deleteWip(existing.id);
        return onHead
          ? ({ promptId } as PromptRef)
          : ({ promptId, version: base } as PromptRef);
      }
      const wip = existing
        ? await store.updateWip(existing.id, { updates: canonical })
        : await store.putWip({
            promptId,
            ...(basePrompt.globalId && { globalId: basePrompt.globalId }),
            base,
            updates: canonical,
            onHead,
          });
      return { promptId, variation: wip.id } as PromptRef;
    });

    this.host.emit({ type: "change", promptId, ref: landed });
    const prompt = await this.getPrompt(landed);
    if (!prompt) throw new Error("Prompt not found");
    return { prompt, ref: landed };
  }

  /**
   * What running `ref` runs: the version it pins, and the variation — frozen,
   * and rebased onto head — applied on top of it, if any.
   *
   * @throws {@link VariationConflictError} when the variation can't be applied
   *   to head without choosing between two changes.
   */
  async prepareRun(
    ref: PromptRef,
  ): Promise<{ version: VersionInfo; variation?: StoredVariation }> {
    const [filePath] = this.host.parsePromptId(ref.promptId);

    if (ref.variation === undefined) {
      if (
        ref.version !== undefined &&
        !(await this.isHeadContent(ref.version, filePath))
      ) {
        throw new Error(
          "Running is only available on the working tree. Open this version " +
            "on the working tree to run it.",
        );
      }
      return { version: await this.snapshotFor(filePath) };
    }

    const store = this.requireStore();
    const v = await store.get(ref.variation);
    if (!v) throw new Error(`No variation ${ref.variation}`);
    if (v.pending) throw new VariationConflictError(v.pending.conflicts);

    // Every trace points at an immutable variation: a WIP runs as the frozen
    // row of its current updates, and running unchanged edits twice reuses it.
    const frozen = v.wip
      ? await store.intern({
          promptId: v.promptId,
          globalId: v.globalId,
          base: v.base,
          updates: v.updates,
        })
      : v;

    const location = await this.headLocation(frozen);
    const head = await this.snapshotFor(location.filePath);
    if (frozen.base === head.id) {
      return {
        version: head,
        variation: isEmptyUpdates(frozen.updates) ? undefined : frozen,
      };
    }
    const outcome = await this.rebaseOnto(frozen, head.id, location.promptId);
    if (!outcome.ok) throw new VariationConflictError(outcome.conflicts);
    if (isEmptyUpdates(outcome.updates)) return { version: head };
    return {
      version: head,
      variation: await store.intern({
        promptId: outcome.promptId,
        globalId: frozen.globalId,
        base: head.id,
        updates: outcome.updates,
      }),
    };
  }

  /** The prompt a prepared run will run — for recording its parameters. */
  async preparedPrompt(
    variation: StoredVariation,
  ): Promise<NormalizedFilePrompt> {
    return this.withHeadTypes((await this.materialize(variation)).prompt);
  }

  /**
   * Called when prompt files changed on disk: rebases their head WIPs (see
   * {@link currentHeadWip}) and tells watchers about any WIP that moved.
   */
  async onPromptsChanged(promptIds: string[]): Promise<void> {
    this.invalidate();
    if (!this.store) return;
    for (const promptId of promptIds) {
      const before = await this.store.getHeadWip(promptId);
      if (!before) continue;
      const after = await this.withWipLock(promptId, () =>
        this.currentHeadWip(promptId),
      );
      if (after?.updatedAt !== before.updatedAt) {
        this.host.emit({
          type: "change",
          promptId,
          ref: after ? { promptId, variation: after.id } : { promptId },
        });
      }
    }
  }

  /**
   * Moves a prompt's head WIP along with a rename: rebased onto the renamed
   * prompt at head, under its new id.
   */
  async onPromptRenamed(oldId: string, newId: string): Promise<void> {
    const store = this.store;
    if (!store) return;
    this.invalidate();
    // Under the old id's lock, so an edit to the WIP can't land between
    // reading it and moving it.
    await this.withWipLock(oldId, async () => {
      const wip = await store.getHeadWip(oldId);
      if (!wip) return;
      const [filePath] = this.host.parsePromptId(newId);
      const head = await this.snapshotFor(filePath);
      const outcome = await this.rebaseOnto(wip, head.id, newId);
      await store.deleteWip(wip.id);
      if (outcome.ok && isEmptyUpdates(outcome.updates)) return;
      const moved = await store.putWip({
        promptId: newId,
        ...(wip.globalId && { globalId: wip.globalId }),
        base: head.id,
        updates: outcome.updates,
        onHead: true,
      });
      if (!outcome.ok) {
        await store.updateWip(moved.id, {
          pending: {
            onto: head.id,
            updates: outcome.updates,
            conflicts: outcome.conflicts,
            labels: REBASE_LABELS,
          },
        });
      }
    });
  }

  /**
   * Brings a variation into the prompt's head WIP (§G): rebases it onto
   * head — onto the WIP's own base when there is a WIP, since merging needs
   * both sides against one base — then merges it in field by field.
   *
   * Changes nothing when a field conflicts, unless `options` says how to
   * settle it: the conflicts come back, labelled, for the caller to choose —
   * throw the unsaved edits away (`replace`), pick a side per field
   * (`choices`), or leave everything as it was.
   *
   * @param build - The variation to bring, given the version it will land on.
   */
  private openOnHeadFrom(
    location: { promptId: string; filePath: string },
    { label, originName }: { label: string; originName?: string },
    build: (target: VersionId) => Promise<StoredVariation>,
    { choices, replace }: OpenOnHeadOptions = {},
  ): Promise<RebaseResult & { promptId: string }> {
    const store = this.requireStore();
    const settles = (conflicts: VariationConflict[]) =>
      !!choices && conflicts.every(c => choices[c.field]);

    return this.withWipLock(location.promptId, async () => {
      let wip = await this.currentHeadWip(location.promptId);
      if (wip && replace) {
        await store.deleteWip(wip.id);
        wip = undefined;
      }
      if (wip?.pending) {
        return {
          ok: false,
          conflicts: wip.pending.conflicts,
          labels: wip.pending.labels,
          promptId: location.promptId,
        };
      }
      const target =
        wip?.base ?? (await this.snapshotFor(location.filePath)).id;
      const x = await build(target);
      const rebased = await this.rebaseOnto(x, target, location.promptId);
      let incoming = rebased.updates;
      if (!rebased.ok) {
        const labels = { target: "working tree", variation: label };
        if (!settles(rebased.conflicts)) {
          return {
            ok: false,
            conflicts: rebased.conflicts,
            labels,
            promptId: rebased.promptId,
          };
        }
        const headPrompt = await this.promptAtVersion(target, rebased.promptId);
        if (!headPrompt) throw new Error("Prompt not found");
        incoming = resolveConflicts(
          headPrompt,
          {
            onto: target,
            updates: rebased.updates,
            conflicts: rebased.conflicts,
            labels,
          },
          choices!,
        );
      }

      if (!wip) {
        if (isEmptyUpdates(incoming)) {
          // Already applied: nothing to open.
          return {
            ok: true,
            variation: toInfo({ ...x, base: target, updates: incoming }),
            promptId: rebased.promptId,
          };
        }
        const created = await store.putWip({
          promptId: rebased.promptId,
          ...(x.globalId && { globalId: x.globalId }),
          base: target,
          updates: incoming,
          onHead: true,
          ...(originName && { originName }),
        });
        return {
          ok: true,
          variation: toInfo(created),
          promptId: rebased.promptId,
        };
      }

      const headPrompt = await this.promptAtVersion(target, wip.promptId);
      if (!headPrompt) throw new Error("Prompt not found");
      const merged = mergeIntoWip(headPrompt, wip.updates, incoming);
      let updates = merged.updates;
      if (!merged.ok) {
        const labels = { target: "unsaved edits", variation: label };
        if (!settles(merged.conflicts)) {
          return {
            ok: false,
            conflicts: merged.conflicts,
            labels,
            promptId: wip.promptId,
          };
        }
        updates = resolveConflicts(
          headPrompt,
          {
            onto: target,
            updates: merged.updates,
            conflicts: merged.conflicts,
            labels,
          },
          choices!,
        );
      }
      if (isEmptyUpdates(updates)) {
        await store.deleteWip(wip.id);
        return {
          ok: true,
          variation: toInfo({ ...wip, updates }),
          promptId: wip.promptId,
        };
      }
      const updated = await store.updateWip(wip.id, { updates });
      return { ok: true, variation: toInfo(updated), promptId: wip.promptId };
    });
  }

  // ── The public capabilities ───────────────────────────────────────────────

  /** {@link PromptVersions} over this provider's versioning adapter. */
  readonly versions: PromptVersions = {
    snapshot: promptId =>
      this.versioning.snapshot(
        promptId === undefined ? undefined : this.relativePathOf(promptId),
      ),
    history: (promptId, options) =>
      this.versioning.history(this.relativePathOf(promptId), options),
    get: id => this.versioning.get(id),
  };

  /** {@link PromptVariations} over this provider's variation store. */
  readonly variations: PromptVariations = {
    get: async id => {
      const v = await this.requireStore().get(id);
      return v && toInfo(v);
    },

    list: async promptId =>
      (await this.requireStore().list(promptId)).map(toInfo),

    name: async (id, name) => {
      const store = this.requireStore();
      if (!name.trim()) throw new Error("A variation's name can't be empty");
      return this.withVariation(id, async v => {
        if (v.pending) throw new VariationConflictError(v.pending.conflicts);
        // Naming a WIP names the frozen row of its current updates; the WIP
        // carries on, as the unsaved edits it still is.
        const frozen = v.wip
          ? await store.intern({
              promptId: v.promptId,
              globalId: v.globalId,
              base: v.base,
              updates: v.updates,
            })
          : v;
        await store.name(frozen.id, frozen.promptId, name.trim());
        if (v.wip && v.originName) {
          await store.updateWip(v.id, { originName: null });
        }
        this.host.emit({ type: "change", promptId: v.promptId });
        return toInfo((await store.get(frozen.id))!);
      });
    },

    unname: async (promptId, name) => {
      await this.requireStore().unname(promptId, name);
      this.host.emit({ type: "change", promptId });
    },

    rebase: async (id, onto) => {
      const store = this.requireStore();
      return this.withVariation(id, async (v): Promise<RebaseResult> => {
        const location = onto ? undefined : await this.headLocation(v);
        const target = onto ?? (await this.snapshotFor(location!.filePath)).id;
        const outcome = await this.rebaseOnto(v, target, location?.promptId);
        if (!outcome.ok) return { ok: false, conflicts: outcome.conflicts };
        if (v.wip) {
          const moved = await store.updateWip(v.id, {
            base: target,
            updates: outcome.updates,
            pending: null,
          });
          this.host.emit({
            type: "change",
            promptId: v.promptId,
            ref: { promptId: v.promptId, variation: v.id },
          });
          return { ok: true, variation: toInfo(moved) };
        }
        const rebased = await store.intern({
          promptId: outcome.promptId,
          globalId: v.globalId,
          base: target,
          updates: outcome.updates,
        });
        return { ok: true, variation: toInfo(rebased) };
      });
    },

    openOnHead: async (id, options) => {
      const x = await this.requireStore().get(id);
      if (!x) throw new Error(`No variation ${id}`);
      if (x.pending) {
        return { ok: false, conflicts: x.pending.conflicts };
      }
      const label = x.names[0] ?? x.originName ?? "variation";
      const location = await this.headLocation(x);
      const { promptId, ...outcome } = await this.openOnHeadFrom(
        location,
        { label, originName: x.names[0] },
        async () => x,
        options,
      );
      this.host.emit({ type: "change", promptId });
      return outcome;
    },

    openVersionOnHead: async (promptId, version, options) => {
      const old = await this.promptAtVersion(version, promptId);
      if (!old) throw new Error(`${promptId} doesn't exist at ${version}`);
      const [filePath] = this.host.parsePromptId(promptId);
      const info = await this.versioning.get(version);
      const label = info ? versionLabel(info) : shortId(version);
      // The old version's values, as edits to head: based on the target
      // itself, so every field it sets is simply taken.
      const { promptId: landedOn, ...outcome } = await this.openOnHeadFrom(
        { promptId, filePath },
        { label },
        async target => ({
          id: "",
          promptId,
          ...(old.globalId && { globalId: old.globalId }),
          base: target,
          updates: fieldUpdatesOf(old),
          wip: false,
          names: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
        options,
      );
      this.host.emit({ type: "change", promptId: landedOn });
      return outcome;
    },

    save: async wipId => {
      const store = this.requireStore();
      const result = await this.withVariation(
        wipId,
        async (v): Promise<RebaseResult & { promptId: string }> => {
          if (v.pending) {
            return {
              ok: false,
              conflicts: v.pending.conflicts,
              promptId: v.promptId,
            };
          }
          let [filePath] = this.host.parsePromptId(v.promptId);
          let promptId = v.promptId;
          let updates = v.updates;
          // Onto a fresh head first, unless it's already head's.
          if (!(await this.isHeadContent(v.base, filePath))) {
            this.invalidate();
            const location = await this.headLocation(v);
            const head = await this.snapshotFor(location.filePath);
            const outcome = await this.rebaseOnto(
              v,
              head.id,
              location.promptId,
            );
            if (!outcome.ok) {
              return {
                ok: false,
                conflicts: outcome.conflicts,
                promptId: v.promptId,
              };
            }
            promptId = outcome.promptId;
            updates = outcome.updates;
            [filePath] = this.host.parsePromptId(promptId);
          }

          const [, name] = this.host.parsePromptId(promptId);
          if (!isEmptyUpdates(updates)) {
            await this.host.mutateFile(filePath, () =>
              this.host.applyUpdates(
                this.host.fileType,
                filePath,
                name,
                promptId,
                updates,
              ),
            );
          }
          await store.deleteWip(v.id);
          this.invalidate();
          return {
            ok: true,
            variation: toInfo({ ...v, updates }),
            promptId,
          };
        },
        { wip: true },
      );
      const { promptId, ...outcome } = result;
      this.host.emit({ type: "change", promptId });
      return outcome;
    },

    discard: async id => {
      const store = this.requireStore();
      const promptId = await this.withVariation(id, async v => {
        if (!v.wip) throw new Error("Only unsaved edits can be discarded");
        await store.deleteWip(id);
        return v.promptId;
      });
      this.host.emit({ type: "change", promptId });
    },

    resolve: async (id, choices: ConflictChoices) => {
      const store = this.requireStore();
      const { promptId, ...result } = await this.withVariation(
        id,
        async (current): Promise<RebaseResult & { promptId: string }> => {
          const { promptId, pending } = current;
          if (!pending) {
            return { ok: true, variation: toInfo(current), promptId };
          }
          const target = await this.promptAtVersion(pending.onto, promptId);
          if (!target) throw new Error("Prompt not found");
          const updates = resolveConflicts(target, pending, choices);
          if (isEmptyUpdates(updates)) {
            await store.deleteWip(id);
            return {
              ok: true,
              variation: toInfo({ ...current, base: pending.onto, updates }),
              promptId,
            };
          }
          const resolved = await store.updateWip(id, {
            base: pending.onto,
            updates,
            pending: null,
          });
          return { ok: true, variation: toInfo(resolved), promptId };
        },
        { wip: true },
      );
      this.host.emit({
        type: "change",
        promptId,
        ref: { promptId, variation: id },
      });
      return result;
    },
  };
}
