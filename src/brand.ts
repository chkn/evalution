// SPDX-License-Identifier: MIT OR AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

export function makeBrand<T extends object>(sym: symbol) {
  return {
    brand: <U extends T>(value: U) =>
      Object.defineProperty(value, sym, { value: true }),
    isBranded: (value: any): value is T =>
      typeof value === "object" && value !== null && value[sym] === true,
  };
}
