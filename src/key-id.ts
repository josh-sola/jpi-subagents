/**
 * key-id.ts — validates a user-configured key identifier against the grammar
 * `matchesKey` (`@earendil-works/pi-tui`) accepts, since that function itself
 * never rejects a malformed one — it just silently never matches, which would
 * make a typo in `background-shortcut` read as "the feature stopped working".
 */

const BASE_KEYS = new Set([
  ..."abcdefghijklmnopqrstuvwxyz",
  ..."0123456789",
  "`", "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/",
  "!", "@", "#", "$", "%", "^", "&", "*", "(", ")", "_", "+", "|", "~", "{", "}", ":", "<", ">", "?",
  "escape", "esc", "enter", "return", "tab", "space", "backspace", "delete", "insert", "clear",
  "home", "end", "pageup", "pagedown", "up", "down", "left", "right",
  "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
]);

const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);

/** Whether `keyId` parses as a valid `matchesKey` identifier (case-insensitive). */
export function isValidKeyId(keyId: string): boolean {
  if (keyId.trim() === "") return false;
  const parts = keyId.toLowerCase().split("+");
  const base = parts[parts.length - 1];
  if (!BASE_KEYS.has(base)) return false;
  return parts.slice(0, -1).every(part => MODIFIERS.has(part));
}

/** The configured shortcut, or `fallback` when it doesn't parse as a key identifier. */
export function resolveKeyId(configured: string, fallback: string): string {
  return isValidKeyId(configured) ? configured : fallback;
}
