// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const packagesDir = path.join(import.meta.dirname, "..", "packages");

function publishedSources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === "node_modules" || entry.name === "dist") return [];
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return publishedSources(file);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
      ? [file]
      : [];
  });
}

const specifiers = (source: string) =>
  [
    ...source.matchAll(
      /(?:\bfrom\s+|\bimport\s+|\bimport\(\s*)["']([^"']+)["']/g,
    ),
  ].map(m => m[1]);

describe("the MIT packages", () => {
  const files = publishedSources(packagesDir);

  it("finds the packages' sources", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(
    files.map(f => [path.relative(packagesDir, f), f]),
  )("%s doesn't import the AGPL core", (_name, file) => {
    const packageRoot = path.join(
      packagesDir,
      path.relative(packagesDir, file).split(path.sep)[0],
    );
    for (const specifier of specifiers(fs.readFileSync(file, "utf8"))) {
      expect(
        specifier === "evalution" || specifier.startsWith("evalution/"),
      ).toBe(false);
      if (!specifier.startsWith(".")) continue;
      const target = path.resolve(path.dirname(file), specifier);
      expect(target.startsWith(packageRoot + path.sep)).toBe(true);
    }
  });
});
