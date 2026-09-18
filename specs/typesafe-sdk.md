# Proposal: TypeSafe (System One) support — prompt styles owned by the SDK adapter

> **Status: DRAFT (2026-09-16), revision 4.** Nothing here is built yet. Based on
> `@typesafe-ai/sdk@0.6.0` (the `.d.mts` and `dist/index.mjs` in the published tarball) and the
> live docs at `docs.typesafe.ai`. No public API is frozen, and no trace database exists outside
> this repo, so this breaks `NormalizedPrompt`, `LLMSpanDetails` and the trace schema freely.

## Context

Every prompt Evalution understands today is a **chat prompt**: a model, a system message, a list
of messages, and sampling parameters in, text (and tool calls) out. `NormalizedPrompt` hard-codes
that shape, and `PlaygroundEditor` renders it directly: model row, Settings/Tools/Output pills, a
system card, message cards, "＋ Add message".

TypeSafe's System One models (Jev is the first) are a different kind of model:

```ts
client.systemOne({
  model: "jev-latest",                       // optional; client default otherwise
  state: { ticket, refund_policy },          // string | JSON object | JSON array
  questions: {                               // id → typed question; ids are NOT sent to the model
    refund_requested: noul(`Does the customer ask for a refund for ${product}?`),
    team: choice("Which team should handle this?", { billing: "Payments…", technical: null }),
    frustration: score("How frustrated is the customer?", ["Calm", "Frustrated", "Very angry"]),
  },
});
// → { model, answers: { refund_requested: { type: "noul", noul: 0.93 },
//                       team: { type: "choice", choice: "billing", probabilities, confidence },
//                       frustration: { type: "score", score: 1.4, legend, probabilities, confidence } },
//     usage: { input_tokens, output_tokens } }
```

| Chat prompt                      | System One request                                                  |
| -------------------------------- | ------------------------------------------------------------------- |
| `model`                          | `model` (a plain string; `client.models.list()` enumerates them)    |
| `system` + `messages` (authored) | `questions` (authored): instructions + criteria per question         |
| function params interpolated in  | function params interpolated into **both** `state` and `questions`  |
| sampling params (`temperature`)  | none in the request body                                            |
| text (or structured output) out  | one typed answer per question, with probabilities and confidence    |

The authored, iterated-on part of a System One prompt is the questions, and the playground needs
an editor built around them. That choice belongs to the `SDKAdapter`, so chat adapters keep their
system/messages editor. **The design goal is that nothing in Evalution's own types is specific to
TypeSafe.** The adapter describes the SDK's types as `PropDefinition`s. The client edits
`PropValue`s generically, and any TypeSafe-aware UI is an optional ts-proppy editor plugin on top.

---

## Key findings that shape the approach

1. **Extra keys on the request object are sent to the API.** `systemOne` builds its body as
   `{ ...request, model: request.model ?? this.defaultModel }` and `JSON.stringify`s it. The
   Vercel `prompts()` helper works by adding `telemetry` keys to the config it returns. A TypeSafe
   helper **cannot** do that: the keys would reach the API and fail validation. Prompt identity
   has to live under a **symbol key**, which survives a user's `{ ...p.triage(t) }` spread and is
   dropped by `JSON.stringify`.

2. **The SDK has no telemetry hook** (only a `logger` and a `fetch` override, and neither sees
   the prompt identity). So the adapter records spans itself in the playground, and a client
   wrapper does it at runtime (§H).

3. **ts-proppy can't yet describe or edit the SDK's types.** These gaps are generic rather than
   TypeSafe-specific:
   - *Index signatures.* `Questions` (`{ [name: string]: Question }`) and `ChoiceCriteria` have no
     `PropType`. There is no `record` kind.
   - *Variadic tuples.* `ScoreCriteria` is `readonly [EntryType, EntryType, ...EntryType[]]`.
     `build-prop-type-from-type.ts` maps a tuple through `getTypeArguments` without reading
     `ElementFlags`, so the rest element becomes a third fixed element.
   - *Calls as values.* `choice("…", {…})` is a `functionCall` PropValue. The only
     function-related editor, `FunctionEditor`, edits lambda bodies. Nothing edits a call's
     arguments against the function's parameters.
   - *Interpolation below the top level.* `interpolatables` lives on the `PropDefinition` handed
     to `ItemEditor`, and only `TemplateEditor` reads it. `ObjectEditor`, `ArrayEditor`, the union
     editors and plugins don't pass it down. So `${ticket.subject}` works in a system message but
     would not work in a choice description nested three levels into `questions`.

4. **Interpolating into `state` isn't string interpolation.** `state: { ticket }` puts the object
   itself into the state, not `${ticket}` coerced to a string. ts-proppy parses a bare identifier
   as `raw` (`extraction/helpers.ts`), which `isEditable` rejects. So state needs a whole-value
   **reference** to a parameter, as well as templates inside its string fields.

5. **Edits are top-level-property granular.** `updatePromptProperties` needs a `valueSpan`, and
   only top-level definitions carry one. So a question edit rewrites the whole `questions` literal,
   the same way message edits rewrite `messages` today. `mapFunctionCalls` already recurses into
   nested objects, so a new `choice(...)` nested in `questions` gets its import candidate resolved.

6. **The route mints the root span id but doesn't pass it on.** On the native path
   `api-routes.ts` names the root span `${traceId}:root`. The Vercel ingestor knows this only by
   convention. `ExecuteConfigOptions` should carry `rootSpanId`.

7. **The model list can be live.** `client.models.list()` returns `ModelCard[]`, with a
   `jev-latest` fallback when there is no key or no network.

---

## A. `NormalizedPrompt` becomes a union on `style`

```ts
interface NormalizedPromptBase {
  id; providerId?; globalId?; name; functionParameters; metadata?; treePath?;
  model?: PropValue;
  /** Whether this SDK lets the model be chosen from the playground. */
  modelEditable: boolean;
  modelParameters: NormalizedParameter[];
  executeParameters?; inputSources?; inputLayout?;
}

/** A model driven by a system message and a conversation. */
export interface NormalizedChatPrompt extends NormalizedPromptBase {
  style: "chat";
  system?: PropValue;
  /** Whether this SDK supports an arbitrary system message. */
  systemEditable: boolean;
  messages: NormalizedMessage[];
  /** Whether this SDK supports an arbitrary message list. */
  messagesEditable: boolean;
}

/** A model that answers a set of named questions about a state. */
export interface NormalizedQuestionsPrompt extends NormalizedPromptBase {
  style: "questions";
  /** What the questions are asked about. `def` is the SDK's state type. */
  state: NormalizedParameter;
  /** Whether this SDK supports an arbitrary state. */
  stateEditable: boolean;
  /**
   * The questions, as one value: an object whose property names are question ids. `def` is the
   * SDK's type for the whole collection: a `record` whose value definition carries a
   * `ValueCatalog` of question factories (TypeSafe's `noul`, `choice`, `score`; see §C.4).
   */
  questions: NormalizedParameter;
  /** Whether this SDK supports adding, removing and editing questions. */
  questionsEditable: boolean;
}

export type NormalizedPrompt = NormalizedChatPrompt | NormalizedQuestionsPrompt;
```

There's no hard-coded question shape and no `form` field: a question is a `functionCall` or an
`object` PropValue, and the kind says which. There's also no Evalution-level factory type, because
the question factories are ordinary ts-proppy catalog metadata on the `questions` definition (§C.4).

- **Two kinds of editability, answered in two places.**
  - *What the SDK supports* is the adapter's to state, so the `*Editable` flags stay. They now
    mean capability ("this SDK takes an arbitrary system message"), not "the value parsed into
    something editable". Step 1 changes `VercelAISDK` and `GeminiInteractionsSDK` accordingly.
    Today both compute the flags with `isEditable(value)`, and they become constants.
  - *Whether this value's shape can be edited* is the editor's question. It checks `isEditable`
    (or ts-proppy decides) on whatever it is about to render, and renders read-only when either
    answer is no.
  - `NormalizedParameter.editable` only ever answered the second question, so it goes, and
    `NormalizedParameter` becomes `{ def, value? }`.
- **Types come from the adapter,** not from Evalution (§F). If TypeSafe adds a fourth primitive,
  the playground can edit it without an Evalution release.
- **Ordering.** Question order is the property order of the object PropValue, which is source
  order. The exception is integer-like ids (`"1"`), which JS objects reorder. That is also their
  runtime order, so it is not worth a parallel list.

**The adapter owns the style.** `normalizePrompt` returns the union, so no new method is needed.
`VercelAISDK` and `GeminiInteractionsSDK` add `style: "chat"`, and `TypeSafeSDK` returns
`"questions"`. A closed set of styles is right because the client is a prebuilt bundle and
adapters can't ship React. They choose among editors the client has, and within an editor the
generic PropValue machinery (plus optional plugins) handles the rest.

## B. Updates follow the same split

```ts
export interface ChatPromptUpdates {
  style: "chat";
  model?; system?: PropValue | null; messages?: NormalizedMessage[] | null;
  modelParameters?: Record<string, PropValue | null>;
}
export interface QuestionsPromptUpdates {
  style: "questions";
  model?; state?: PropValue | null; questions?: PropValue | null;
}
export type NormalizedPromptUpdates = ChatPromptUpdates | QuestionsPromptUpdates;
```

`denormalizeUpdates` throws on a style it doesn't produce. `applyOptimisticUpdates` switches on
`style`. For TypeSafe, denormalizing is nearly the identity (`state` → `state`, `questions` →
`questions`), because the values are already source-shaped.

## C. ts-proppy prerequisites (finding 3–4)

All of these are generic ts-proppy features with no knowledge of TypeSafe. The rule is to push
abstractions down into ts-proppy rather than build specific ones in Evalution.

1. **Element slots are definitions.** A container's element becomes a `PropDefinition` instead of
   a bare `PropType`, so an element slot can carry docs, interpolatables and a catalog (item 4):
   - `array.elementType: PropType` → `array.element: PropDefinition`
   - `tuple.types: PropType[]` → `tuple.elements: PropDefinition[]`

   This is mechanical. `elementType` appears at about ten sites in ts-proppy: the type, three
   extraction builders, `ItemEditor`, `RichEditor`, `format-syntax`, `ArrayEditor`, and
   `TupleEditor`, which already fabricate a `PropDefinition` around the bare type. In Evalution it
   appears only in the two adapters' `FALLBACK_*` constants. Element names are `""` for arrays and
   `[i]` for tuples, as the editors already synthesize.
2. **`record` PropType:** `{ kind: "record"; syntax; value: PropDefinition }`, built from a string
   index signature with no named members. Its editor is a `RecordEditor` with key + value rows.
   Keys can be renamed in place (order is kept), added and removed, and must be unique and
   non-empty. Values go through `ItemEditor` with the path extended by the key.
   **Variadic tuples:** `tuple` gains `rest?: PropDefinition`, read from `ElementFlags.Rest`.
   `TupleEditor` renders fixed elements, then appendable rest elements, and never goes below
   `elements.length`.
3. **Binding candidates in `PropValue`:** `functionCall.binding` accepts
   `CalleeBinding | CalleeBinding[]`. Resolving candidates against a file (today
   `resolveBindingsAndAugment` in `ts-prompt-file-type.ts`) moves into ts-proppy's editing module,
   and Evalution's `ModelPropValue` goes away.
4. **Value catalogs:** ready-made values and factories offered for a slot beside its own editor.
   This generalizes both `ModelCatalog` and the question factories:

   ```ts
   interface PropDefinition { /* … */ interpolatables?; catalogs?: ValueCatalog[] }

   /** One way of choosing a value for a slot, e.g. "Provider" or "Gateway" for a model. */
   interface ValueCatalog {
     label: string;
     description?: string;
     groups: ValueCatalogGroup[];
     /**
      * Offer a free-form entry (the Gateway "custom string" row): `true` for the slot's own editor,
      * or a definition narrowing it to part of the slot's type (Gemini's Models vs Agents, §D.4).
      */
     literal?: boolean | PropDefinition;
   }

   interface ValueCatalogGroup {
     label: string;
     /** Host-interpreted icon key (Evalution maps it to `ProviderIcon`). */
     icon?: string;
     /** Ready-made values, e.g. `openai("gpt-5.5")` labelled "GPT-5.5". */
     presets?: { label: string; value: PropValue }[];
     /** Calls to this function fill the slot, edited argument by argument. */
     factory?: ValueFactory;
   }

   /** A function whose call produces a value for the slot, and where its callee comes from. */
   interface ValueFactory {
     /** A `function`-kind definition; `name` is the callee. */
     def: PropDefinition;
     binding: CalleeBinding | CalleeBinding[];
   }
   ```

   Editor behaviour:
   - `ItemEditor` routes a slot with `catalogs` to a `CatalogEditor`. That is today's
     `ModelPicker`, generalized and moved down: a mode toggle when there is more than one catalog,
     grouped presets, the selected preset shown by label, and a free-form row when `literal`.
   - A group with a `factory` gets a custom row that inserts a call with default arguments.
   - A current value that is a call to a known factory, but not a preset, opens in
     `FunctionCallEditor` (item 5) against that factory's parameters.
   - A host supplies icon rendering through a prop or plugin.

   Mapping the existing catalogs onto it:

   | Today (`ModelCatalog`)                  | Value catalogs                                                   |
   | --------------------------------------- | ---------------------------------------------------------------- |
   | `modelValueTypes` (Provider / Gateway)  | one `ValueCatalog` each                                          |
   | `ModelInfo.group` + `ProviderIcon`      | `ValueCatalogGroup.label` / `icon`                               |
   | `ModelInfo.values[mode]`                | a preset in that catalog's group                                 |
   | `customValueTemplates` + `$input`       | `factory` (`openai(modelId)`), edited by argument (item 8)       |
   | Gateway free-form string row            | `literal: true` on the Gateway catalog, with suggestions (item 8)|
   | Gemini model/agent `{ key, value }`     | a union-typed config fragment (§D.4)                             |
   | TypeSafe question factories             | one catalog, a group per factory, no presets                     |

   `SDKAdapter.getModelCatalog()` becomes `getModelDefinition(…)`, which returns the model slot's
   `PropDefinition` including its catalogs. It stays a per-SDK endpoint rather than being copied
   onto every prompt, because the checker-derived suggestions (item 8) can run to hundreds of IDs.
5. **Call-argument editing:** a `FunctionCallEditor` that takes a `functionCall` value and a
   `function`-kind definition and renders one `ItemEditor` per parameter against `args[i]`.
   `ItemEditor` routes to it when the value is a call to a factory in the slot's catalogs. A call
   to anything else renders read-only, as today.
6. **Interpolation all the way down:** thread `interpolatables` through every container editor and
   into plugins (a prop, or a React context set by `ItemEditor`/`PropsEditor`), so any
   string-typed slot at any depth gets a `TemplateEditor` with `${…}` completion.
7. **Parameter references:** a new PropValue `{ kind: "reference"; path: string[] }`.
   - *Parsing:* an identifier or property-access chain that resolves to an interpolatable root,
     including shorthand `{ ticket }`.
   - *Writing:* `ticket.subject`, or shorthand when the key matches the last path segment.
   - *Editing:* shown as the same token chip `TemplateEditor` uses. Wherever interpolatables are
     available, a non-string slot (object, array, union member, JSON fallback) offers "insert
     parameter" to set a reference in place of a literal.
   - This is what makes `state: { ticket, policy: POLICY_TEXT }` editable rather than `raw`.
     Module-level constants such as `POLICY_TEXT` stay `raw` unless we later make top-level
     bindings interpolatable too.
8. **Open string unions as suggestions.** Every SDK here types its model IDs the same way:
   `'gpt-4o' | 'o3' | … | (string & {})`. That covers `OpenAIResponsesModelId`, `ai`'s
   `GatewayModelId` (which `LanguageModel` includes), and Gemini's `Model_2` and `AgentOption`.
   ts-proppy currently extracts this as a union of constants plus a branded `string`, which
   routes to `UnionMemberEditor`, a dropdown between "a constant" and "a string".
   - Recognize the shape instead (string constants plus a `string`-based member) and render a
     **combobox**: free text, with the constants as filtered suggestions.
   - The same editor then serves as a factory argument (`openai(▾)`), as the Gateway literal row,
     and as a Gemini model or agent ID. Every ID the *installed* SDK version knows is offered,
     with no curated list involved.

## D. Discovering catalogs from the checker

The Vercel model catalog is currently hand-maintained (`FIXME: Can we read this from the SDK`),
and TypeSafe's question factories should not be hand-maintained either. The two problems are the
same, so they share one mechanism.

### D.1 Two probe scopes, instead of probe roles

Some probes describe a **prompt**: execute parameters, whose expressions reference `$config`.
Others describe the **SDK**: the model slot and the question factories, which are the same for
every prompt in the project. The scope, not a `role` tag, is what distinguishes them:

```ts
interface SDKAdapter {
  /** Was `getExecuteParameterProbes`. Resolved per prompt; may reference `$config`. */
  getPromptProbes?(prompt: ParsedPrompt, language: string): TypeProbe[];
  /** Resolved once per program build, in a virtual module at the project root. */
  getProjectProbes?(language: string): TypeProbe[];

  getModelDefinition(project: ProbeResults): PropDefinition;
  normalizePrompt(prompt: ParsedPrompt, promptProbes: ProbeResult[], project: ProbeResults): NormalizedPrompt;
}
```

- **Where project probes resolve.** A virtual module at `rootDir` has the project's own module
  resolution, so it sees the *installed* SDK versions. It rides in the same program build as
  prompt parsing, and its results are cached until that program changes.
- **How results are passed.** `ProbeResults` is keyed by probe name. Each value is what that
  probe's kind produces (below), `null` for a definite "no", or `undefined` for "could not
  evaluate".
- **Fallbacks.** An adapter substitutes a checked-in snapshot for any `undefined` result, as the
  `FALLBACK_*` constants do today.

### D.2 A `factories` probe kind

```ts
type TypeProbe =
  /** Resolves to a `PropDefinition` (today's probe). */
  | { kind: "type"; name: string; expression: string; syntax?: string; description?: string }
  /**
   * Resolves to `ValueFactory[]`: every export of `modules` that can be called to produce a
   * value assignable to `produces`.
   */
  | { kind: "factories"; name: string; modules: string[]; produces: string };
```

The adapter says *what* to look for. The file type knows *how* to ask in its language, the same
way it owns `$config` substitution. For TypeScript that means:

1. One injected alias per module, so a module that isn't installed only affects its own alias:

   ```ts
   type $factories_n = 0 extends 1 & typeof import("<module>") ? never : {
     [K in keyof typeof import("<module>") as typeof import("<module>")[K] extends (...args: any) => infer R
       ? 0 extends 1 & R ? never : [R] extends [<produces>] ? K : never
       : never]: typeof import("<module>")[K]
   };
   ```

   The `0 extends 1 & X` guards drop `any`. A module that isn't installed types as `any` rather
   than failing the build. *To verify:* the checker still types the sibling aliases in the same
   injected file.
2. Each surviving member becomes
   `{ def: <function-kind definition>, binding: { kind: "import", spec: { name, from: module } } }`.

What the filter handles for free:
- *Non-language providers:* `elevenlabs`'s call returns `{ transcription }`, which isn't a
  `LanguageModel`.
- *Provider constructors:* `createOpenAI` returns a provider, not a model.
- *Uninstalled packages:* they contribute nothing.

One limit: `infer R` against an overloaded call signature sees only the last overload. The
providers and TypeSafe's helpers each have a single call signature. If overloads matter later, the
file type can walk `getCallSignatures()` itself rather than infer.

### D.3 The three SDKs on this mechanism

| SDK      | Model slot (`type` probe)                  | Model catalogs                                                     | Other catalogs |
| -------- | ------------------------------------------ | ------------------------------------------------------------------ | -------------- |
| Vercel   | `import("ai").LanguageModel`               | **Provider:** a group per discovered factory. **Gateway:** literal | —              |
| TypeSafe | `import("@typesafe-ai/sdk").SystemOneRequest["model"]` | one literal catalog, presets live from `models.list()`   | questions: `factories` over `@typesafe-ai/sdk` producing `Question` |
| Gemini   | a config fragment (D.4)                    | **Models** / **Agents**, each literal                              | —              |

How each column gets filled in:
- **Model ID suggestions all come from the checker** via §C.8. `OpenAIResponsesModelId` feeds
  `openai(▾)`, `GatewayModelId` (already part of `LanguageModel`) feeds the Gateway literal row,
  and `Model_2` / `AgentOption` feed Gemini's rows. TypeSafe's `model` is plain `string`, so its
  suggestions are the live presets instead.
- **Vercel provider factories** come from one `factories` probe over the `@ai-sdk/*` packages
  that `@evalution/vercel-ai-sdk`'s `Providers` interface covers, producing
  `import("ai").LanguageModel`. The adapter then:
  - keeps only names that are `Providers` keys
  - prepends today's `{ kind: "parameter", enclosingCall: prompts }` candidate to each binding
  - labels and icons groups from a small name → label map, defaulting to the name

  **The picker now shows only providers the user has installed,** which the hard-coded catalog
  can't do.
- **What stays curated for Vercel:** the package list, the display labels, and the short preset
  list with friendly names (`update-model-catalog`). Presets are now polish rather than the only
  way to reach a model: a group shows its presets only if its factory was discovered, and every
  other ID is one combobox away.

### D.4 Gemini: one model row, two variants of the config

`interactions.create` doesn't take a `model` *and* an `agent`. It takes one of two config shapes
that differ in more than that key:

```ts
type CreateModelInteraction = { model: Model_2;     /* … */ generation_config?: GenerationConfig_2 };
type CreateAgentInteraction = { agent: AgentOption; /* … */ agent_config?: DynamicAgentConfig | DeepResearchAgentConfig };
```

**Two separate fields would be the wrong model.** The playground would show a Model row and an
Agent row, and nothing would stop both from being set or both from being empty. Settings would
keep offering `generation_config` to an agent. Switching would take two edits in two places, with
an invalid config in between.

**Recommendation: keep one model row and make its value an honest config fragment.**
- **Slot type:** the model slot's definition is the union `{ model: Model_2 } | { agent: AgentOption }`,
  probed as `Pick`s of the two members of `interactions.create`'s params.
- **Value:** a prompt's model value is `{ model: "gemini-3.5-flash" }` or
  `{ agent: "deep-research-preview-04-2026" }`.
- **Catalogs:** **Models** and **Agents**, each `literal`, so the free-form row edits only its own
  member. That needs one generic addition: `ValueCatalog.literal?: boolean | PropDefinition`,
  where a definition narrows the free-form editor to part of the slot type.
- **Normalizing:** read whichever key is present into the fragment.
- **Denormalizing:** write the fragment's key and remove the other one. When the variant changes,
  also remove the other variant's settings (`generation_config` ↔ `agent_config`), because they
  are invalid there. `modelParameters` come from the variant in effect.

This is today's `{ key, value }` wrapper made honest. The value is a real, typed piece of the
config instead of an encoding, so presets, suggestions and the literal editor all work on it with
no Gemini-specific UI, and the variant-dependent settings stay inside the adapter.

## E. Interpolation into state and questions

The questions editor builds one `interpolatables` list from `functionParameters` (as
`PlaygroundEditor` does today) and hands it to both the state editor and the questions editor.
With §C.6–7, that gives:

- **State:** a plain string state is a `TemplateEditor`. An object or array state edits field by
  field, where each field can be a literal, a template (`` `${ticket.subject}` ``) or a reference
  (`ticket`).
- **Questions:** instructions, criteria descriptions, score levels and noul true/false text all
  accept `${…}`, including inside structured (object/array) instructions. Choice labels are
  record keys and stay literal, because computed keys would make the answer type unknowable.

**Later:** show the *materialized* state for the current execute-panel inputs by running
`loadConfig` and displaying the `state` it produced. The docs suggest referencing state paths in
instructions (`` `ticket.messages[0].text` ``), and those could be autocompleted from the state's
type.

## F. The `TypeSafeSDK` adapter (`src/sdk/typesafe-sdk/index.ts`)

- **`promptsHelperImport`:** `"@evalution/typesafe-sdk"`.
- **`getModelDefinition`:** a `string` slot with one `literal` catalog and one "TypeSafe" group.
  Its presets come from `client.models.list()` (lazily importing the SDK, cached per adapter,
  falling back to `jev-latest`). There's no factory, because a model is just a string.
- **`getModelParameters`:** `[]`. Per-call `RequestOptions` are transport settings, not prompt
  content. The editor hides Settings when there are none.
- **Types, from the SDK and not hard-coded:** everything is a project probe (§D.1), resolved
  against the *user's installed* SDK. There are no prompt probes:
  - `type` probes for `import("@typesafe-ai/sdk").SystemOneRequest["model"]`, `…["state"]` and
    `…["questions"]`
  - a `factories` probe over `["@typesafe-ai/sdk"]` producing `import("@typesafe-ai/sdk").Question`,
    which finds `noul`, `choice` and `score`, and whatever primitive a later SDK version adds

  Unresolved probes (no checker, SDK not installed) fall back to a checked-in snapshot of the
  same results. The snapshot is a copy of the SDK's types, not an Evalution type.
- **`normalizePrompt`:** reads `state` and `questions` from `extractedProps.values` and pairs them
  with the definitions. It attaches one `ValueCatalog` to the `questions` record's value
  definition: a group per factory the `factories` probe found, no presets, and binding
  `{ kind: "import", spec: { name, from: "@typesafe-ai/sdk" } }`. `modelEditable`,
  `stateEditable` and `questionsEditable` are all `true`, since the SDK takes arbitrary values for
  each. A missing `model` is shown as the client's default.
- **`executeConfig(config, { traceId, rootSpanId, identity })`:**
  1. Lazily import the SDK (`isMissingPackage` / `missingPackageMessage`).
  2. Build the client once, from `new TypeSafeSDK({ client?: TypeSafeClientConfig })`, so tests
     can inject `fetch`.
  3. Record the root span start with `llm.input = { state, questions }`.
  4. Call `systemOne`.
  5. Record the span end with `llm.output = answers`, tokens from `usage`, and `status`. An
     `APIError` sets `errorMessage` from the SDK's own message, which includes 422 field
     locations.
  6. Return `{ done }` without awaiting.
- **`setupTraceIngestion`:** a module-level `TypeSafeTelemetry extends BaseTraceIngestor`.

## G. Spans: `input` and `output` become JSON values

The chat-specific span fields are generalized rather than extended:

```ts
interface LLMSpanDetails {
  provider?; model?; modelParameters?;
  /**
   * What the model was given: a message list for a chat model, or any JSON for a model that
   * takes something else (a System One call records `{ state, questions }`).
   */
  input?: SpanMessage[] | { [key: string]: unknown };
  /**
   * What it returned: text for a chat model, or JSON for structured output and for System One
   * answers.
   */
  output?: unknown;
  promptTokens?; completionTokens?; totalTokens?; cost?;
}

/** The message list of a chat call, or `undefined` for any other input. */
export function spanMessages(llm: LLMSpanDetails | undefined): SpanMessage[] | undefined;
```

Array-ness is the discriminant: a chat call's input is always a message list, and anything else
is wrapped in an object. Consumers of `llm.messages` (`rows.ts` `newMessagesByTurn`, `ChatFlow`,
`MessageList`, `otel-attributes.ts`, the Vercel `telemetry.ts`) switch to `input` or
`spanMessages`.

**Storage.** Rename `llm_messages` → `llm_input`. `llm_output` holds `JSON.stringify(output)` for
every span, so a text output is stored as a JSON string and reads back unambiguously. No database
exists outside this repo, so the initial migration is **regenerated** rather than extended:

1. Edit `schema.ts`.
2. Delete `src/trace/db/migrations/20260911115651_dusty_major_mapleleaf/`.
3. Run `npm run db:generate`.
4. Re-append the hand-written trigger to the new `migration.sql`, after a
   `--> statement-breakpoint`:
   `CREATE TRIGGER \`trg_spans_cascade_delete_trace\` AFTER DELETE ON \`traces\` BEGIN DELETE FROM \`spans\` WHERE \`trace_id\` = OLD.\`id\`; END;`
5. Run `npm run db:bundle`.

**Structured output from chat models.** `output` is a JSON value, not text, whenever the model
produced data:

- **Vercel AI SDK:** a call that declares structured output (`output: Output.object(…)`) still
  reports `event.text` as JSON text. The telemetry parses it into `output` when the call declared
  a structured output, and keeps the string if parsing fails. *To verify:* which v7 telemetry
  event exposes the declared output spec. `config.output` is available to `executeConfig` either
  way.
- **OTel:** when `gen_ai.output.type` is `json`, the output text is parsed. TypeSafe's `instrument()` sets it.

**Trace UI.**

- **`ChatFlow`:** a string `output` renders as the Markdown assistant bubble it is today. A
  non-string `output` renders as a `JsonView` in that bubble. A non-message `input` renders as a
  `JsonView` card where the messages would go.
- **Recognizers:** the trace UI gets the same plugin idea as the editor. An output renderer is
  picked by matching the value's *shape*, falling back to `JsonView`. The System One answers
  renderer matches an object whose values all carry `type: "noul" | "choice" | "score"` with that
  type's fields. It shows noul as a 0–1 bar, choice as per-option bars with the chosen option and
  its confidence, and score as the expected value on a level axis labelled from `legend`, with
  its distribution. Shape matching also works for runtime traces that arrive over OTLP, where no
  adapter is involved. Build it following the `dataviz` guidance.

## H. The companion package: `@evalution/typesafe-sdk` (`packages/typesafe-sdk`, MIT)

```ts
import { choice, noul } from "@typesafe-ai/sdk";
import { prompts } from "@evalution/typesafe-sdk";

export default prompts({ id: "support-triage" }, () => ({
  triage: (ticket: Ticket, product: string) => ({
    state: { ticket },
    questions: {
      refund_requested: noul(`Does the customer ask for a refund for ${product}?`),
      team: choice("Which team should handle this?", { billing: "Payments and refunds", technical: null }),
    },
  }),
}));

// app code
const client = instrument(new TypeSafeClient());
const { answers } = await client.systemOne(triagePrompts().triage(ticket, "Pro plan"));
answers.team.choice; // "billing" | "technical" — criteria types survive the helper
```

- **`prompts()`** returns each config unchanged apart from an enumerable symbol property
  `Symbol.for("evalution.prompt")` holding `PromptSpanInfo` (finding 1). Its generics must
  preserve each prompt function's return type, or the typed answers are lost.
- **`instrument(client)`** wraps `systemOne`. When the request carries the identity symbol, it
  opens a span through `createTracerForPrompt` and sets:
  - `evalution.llm.input` (JSON of `{ state, questions }`)
  - `evalution.llm.output` (JSON of the answers)
  - `gen_ai.output.type = "json"`
  - `gen_ai.usage.*`

  Otherwise it passes the call through.
- The mapping from request/result to span fields lives in a dual-licensed
  `src/sdk/typesafe-sdk/telemetry.ts` that imports only `src/trace/`. `TypeSafeTelemetry` (§F)
  and `instrument()` both use it, and `otel-attributes.ts` learns the two `evalution.llm.*`
  attributes.

## I. Client: split the editor by style

- Move `useSyncedExternal` into `src/client/hooks/`.
- `ChatPromptEditor` is today's editor body, with the Tools/Output placeholder pills.
- The model row is shared: `ItemEditor` over the model definition from `getModelDefinition`, which
  routes to ts-proppy's `CatalogEditor`. `ModelPicker.tsx` is deleted, and `ProviderIcon` is
  supplied as the icon renderer.
- Each card is read-only when the style's capability flag is false *or* the value isn't editable.
- `QuestionsPromptEditor` has two parts:
  - A **State** card: `ItemEditor` over `state`, with interpolatables.
  - A **Questions** list: `ItemEditor` over `questions`, whose `record` type renders one card per
    question with an editable id. Each value's editor falls out of ts-proppy's routing:
    - a call to a catalog factory goes to `FunctionCallEditor`
    - an `object` goes to the SDK's discriminated union, which `DiscriminatedUnionEditor` already
      handles
    - anything else is read-only

    "＋ Add question ▾" is the record's add row. It offers the value definition's catalog groups
    and inserts a call with default arguments under a fresh unique id. The questions editor is
    little more than layout and styling around `ItemEditor`.
- **Optional TypeSafe polish, as ts-proppy `EditorPlugin`s** registered by the client:
  - option rows with description fields for a record of `Description` (choice criteria)
  - a numbered level list for score criteria
  - a collapsed yes/no pair for noul criteria

  They match on type syntax and path. Without them, every slot is still editable through the
  generic editors.
- `PlaygroundEditor` switches on `prompt.style`.

## J. Onboarding and registry

- `TypeSafeSDK.setupTask`: install `@typesafe-ai/sdk`, install `@evalution/typesafe-sdk`, write a
  config with `sdk: new TypeSafeSDK()`, and mention `TYPESAFE_API_KEY`.
- Add the adapter to `AI_SDK_REGISTRY` and export it from `src/index.ts`. Add `@typesafe-ai/sdk`
  as an optional peer dependency and a dev dependency, and add `packages/typesafe-sdk` to
  `workspaces`.

---

## Steps

Each step ships with tests, per `CLAUDE.md`. ts-proppy steps are tested in ts-proppy; remember
to re-link it after any `npm install`.

1. **Style union, chat only.** Split `NormalizedPrompt`/`NormalizedPromptUpdates`. Redefine the
   `*Editable` flags as SDK capabilities and have the editor also check `isEditable`. Drop
   `NormalizedParameter.editable`, add `rootSpanId` to `ExecuteConfigOptions`, rename
   `getExecuteParameterProbes` → `getPromptProbes` with `kind: "type"`, and switch
   `applyOptimisticUpdates`/`PlaygroundEditor`. No visible change. *Tests:* existing adapter, provider and optimistic-update tests updated, a
   rejection test for a foreign style, and a test that a capability-`true` slot holding a `raw`
   value renders read-only.
2. **Span `input`/`output` + regenerated migration.** Rename the field and column, JSON-encode
   `output`, add `spanMessages`, re-add the trigger, and add structured-output parsing for Vercel
   and OTel. *Tests:* `turso-trace-provider.test.ts` round trip for string and object outputs, a
   `schema.test.ts` check that the trigger still exists, `otel-attributes.test.ts`, and Vercel
   telemetry with `Output.object`.
3. **ts-proppy: element definitions, `record`, variadic tuples, open-union combobox, nested
   interpolatables.** Element definitions come first, as a no-behaviour-change refactor.
   *Tests:* extraction tests against `Record<string, T>`, `[A, A, ...A[]]` and
   `'a' | 'b' | (string & {})`; editor tests for rename-in-place, minimum tuple length, and free
   text in the combobox.
4. **ts-proppy: binding candidates, value catalogs (with narrowed `literal`), `CatalogEditor`,
   `FunctionCallEditor`.** Move `resolveBindingsAndAugment` down. *Tests:* candidate resolution
   (moved from Evalution), preset selection by equality, factory-call editing by argument, and
   literal entry narrowed to one union member.
5. **Project probes and the `factories` kind** (§D.1–2) in `FilePromptProvider` and
   `TSPromptFileType`. *Tests:* against `__fixtures__` with real `node_modules`, since this
   exercises package resolution. Cover a discovered provider, a filtered non-language provider, a
   filtered constructor, an uninstalled module next to an installed one in the same batch, and a
   project probe resolving once for several prompts.
6. **Model rows on catalogs.** Replace `getModelCatalog`/`ModelCatalog`/`ModelPropValue` with
   `getModelDefinition`:
   - **Vercel:** discovered factories plus curated presets.
   - **Gemini:** a config fragment with Models/Agents catalogs; variant switching drops the other
     variant's settings.

   Delete `ModelPicker.tsx`. No visible change for Vercel beyond hiding uninstalled providers and
   adding ID suggestions. *Tests:* every former curated entry still appears as a preset, edit
   round trips for provider, gateway and custom values, and a Gemini model → agent switch that
   removes `generation_config`.
7. **ts-proppy: `reference` PropValue** (parse, write, shorthand, chip, "insert parameter").
8. **`TypeSafeSDK`: probes + fallback definitions, model definition, normalize/denormalize.**
   *Tests:* `MemoryFileProvider` + `__fixtures__/typesafe-*.prompt.ts` covering both question
   forms, a raw `questions`, and an edit round trip that adds a `choice` import and a state
   reference.
9. **Execution + playground tracing.** *Tests:* injected `fetch` covering success, 422 and a
   missing package.
10. **`QuestionsPromptEditor`**, then the optional plugins. *Tests:* unit tests for
    add-question id minting. Playwright only for rename focus and nested interpolation
    completion.
11. **Trace UI:** non-message input, JSON output, the answers recognizer. *Tests:* shape matcher
    and layout helpers as unit tests.
12. **`@evalution/typesafe-sdk`:** `prompts()`, `instrument()`. *Tests:* the symbol survives a
    spread and is absent from the serialized body, and answer types are preserved (type-level
    test).
13. **Onboarding** (`setupTask`, registry, docs).

Steps 1–2 stand alone and benefit chat prompts (structured output). Steps 3–7 are the bulk of the
work. They are generalizations in ts-proppy and in the probe machinery, and chat prompts benefit
from them first (nested interpolation, object parameters, a model picker driven by the installed
SDKs). TypeSafe then lands mostly as configuration of those pieces.

## Open questions

- **Do curated presets earn their keep?** Once every model ID is a suggestion from the installed
  types, the curated list only contributes friendly labels and a short "popular" subset. Dropping
  it would retire the `update-model-catalog` skill.
- **Where the snapshot fallback comes from.** A generated file (a script that runs the probes
  against the dev dependency and writes JSON) keeps it honest. A hand-written one will drift.
- **Cost.** Jev's pricing isn't in the cost source, so traces show tokens and no cost.
- **Speculative fan-out.** The docs encourage asking questions that code may ignore. Showing
  which answers were used needs runtime instrumentation, so this is parked.
