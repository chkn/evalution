// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado
//
// Prepends SPDX headers to comment-capable files that lack one. Idempotent.
// Files with no comment syntax (.json, .md, LICENSE*) are covered by REUSE.toml.
//
// Usage:
//   node scripts/add-license-headers.mjs              # sweep all tracked files
//   node scripts/add-license-headers.mjs <file>...    # only the named files
//   node scripts/add-license-headers.mjs --hook       # read a PostToolUse JSON
//                                                      # event on stdin and header
//                                                      # the file it wrote

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, relative, resolve } from "node:path";

const COPYRIGHT = "Copyright (c) 2026 Alexander Corrado";

// REUSE-IgnoreStart  (the strings below contain the SPDX token literally)
const LINE = id => `// SPDX-License-Identifier: ${id}\n// ${COPYRIGHT}\n`;
const HASH = id => `# SPDX-License-Identifier: ${id}\n# ${COPYRIGHT}\n`;
const BLOCK = id =>
  `/* SPDX-License-Identifier: ${id} */\n/* ${COPYRIGHT} */\n`;
const XML = id =>
  `<!-- SPDX-License-Identifier: ${id} -->\n<!-- ${COPYRIGHT} -->\n`;
const SPDX_TAG = "SPDX-License-Identifier";
// REUSE-IgnoreEnd

/** Comment style for a path, or null if the file type has no comment syntax. */
function styleFor(file) {
  const name = basename(file);
  if (name === ".gitignore") return HASH;
  switch (name.slice(name.lastIndexOf(".") + 1)) {
    case "ts":
    case "tsx":
    case "js":
    case "mjs":
    case "cjs":
      return LINE;
    case "yml":
    case "yaml":
    case "toml":
      return HASH;
    case "css":
      return BLOCK;
    case "svg":
    case "html":
      return XML;
    default:
      return null; // json, md, txt, LICENSE* → REUSE.toml
  }
}

const root = (() => {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
    }).trim();
  } catch {
    return process.cwd();
  }
})();

/**
 * Header one file if it is comment-capable, inside the repo, and untagged.
 * Returns 'added' | 'skipped' | 'covered'. Never throws.
 */
function addHeader(file) {
  const abs = resolve(root, file);
  const rel = relative(root, abs);
  if (
    rel.startsWith("..") ||
    rel.startsWith("node_modules/") ||
    rel.startsWith("LICENSES/")
  )
    return "covered";
  const style = styleFor(rel);
  if (!style) return "covered";

  let body;
  try {
    body = readFileSync(abs, "utf8");
  } catch {
    return "covered";
  }
  if (body.split("\n").slice(0, 5).join("\n").includes(SPDX_TAG))
    return "skipped";

  const license = rel.startsWith("packages/vercel-ai-sdk/")
    ? "MIT"
    : "AGPL-3.0-only";
  const lines = body.split("\n");
  // The header must follow a shebang or HTML doctype if the file opens with one.
  const insertAt =
    lines[0]?.startsWith("#!") || /^<!doctype/i.test(lines[0] ?? "") ? 1 : 0;
  const before = lines.slice(0, insertAt).join("\n");
  const rest = lines.slice(insertAt).join("\n");
  writeFileSync(
    abs,
    (before ? before + "\n" : "") +
      style(license) +
      (rest.startsWith("\n") ? rest : "\n" + rest),
  );
  return "added";
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

const args = process.argv.slice(2);

if (args[0] === "--hook") {
  // PostToolUse(Write) hook. Header the file just written, then always exit 0
  // so a hiccup here can never block the agent's tool flow.
  try {
    const event = JSON.parse(await readStdin());
    const file = event?.tool_input?.file_path;
    if (file) addHeader(file);
  } catch {
    /* ignore */
  }
  process.exit(0);
}

const files = args.length
  ? args
  : execSync("git ls-files --cached --others --exclude-standard", {
      cwd: root,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
const tally = { added: 0, skipped: 0, covered: 0 };
for (const f of files) tally[addHeader(f)]++;
console.log(
  `Headers added: ${tally.added}, skipped (already tagged): ${tally.skipped}, not comment-capable: ${tally.covered}`,
);
