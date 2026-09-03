/** Strict 6-digit hex color, e.g. "#E5877E". */
export const HEX_RE = /^#[0-9a-f]{6}$/i;

export function isHex(value: unknown): value is string {
  return typeof value === "string" && HEX_RE.test(value);
}
