/**
 * key-id.test.ts — validates `background-shortcut` against the grammar
 * `matchesKey` (@earendil-works/pi-tui) accepts. `matchesKey` itself never
 * rejects a bad identifier, it just never matches, so this is what turns a
 * config typo into a documented fallback instead of a silently dead shortcut.
 */
import { describe, expect, it } from "vitest";
import { isValidKeyId, resolveKeyId } from "../src/key-id.js";

describe("isValidKeyId", () => {
  it.each([
    "ctrl+b",
    "ctrl+B",
    "CTRL+B",
    "b",
    "escape",
    "f5",
    "shift+ctrl+p",
    "ctrl+alt+x",
    "up",
    "enter",
  ])("accepts %s", (keyId) => {
    expect(isValidKeyId(keyId)).toBe(true);
  });

  it.each([
    "",
    "   ",
    "ctrl+",
    "+b",
    "nonsense+b",
    "ctrl+nonsense",
    "ctrl-b",
  ])("rejects %s", (keyId) => {
    expect(isValidKeyId(keyId)).toBe(false);
  });
});

describe("resolveKeyId", () => {
  it("keeps a valid configured value", () => {
    expect(resolveKeyId("ctrl+g", "ctrl+b")).toBe("ctrl+g");
  });

  it("falls back to the default on an unparseable value", () => {
    expect(resolveKeyId("not a key", "ctrl+b")).toBe("ctrl+b");
  });

  it("falls back on an empty value", () => {
    expect(resolveKeyId("", "ctrl+b")).toBe("ctrl+b");
  });
});
