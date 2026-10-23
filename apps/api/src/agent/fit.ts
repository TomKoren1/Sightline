/**
 * Fitting a tool result into the model's context without breaking it.
 *
 * Cutting the serialised JSON at a character count handed the model a
 * half-written object it had to guess the rest of. Instead whole rows are
 * dropped from the end, and only when one row alone is too big are its long
 * strings shortened - a policy document, say. What is cut is always said.
 */

export interface Fitted {
  rows: unknown[];
  /** Rows dropped from the end. */
  omitted: number;
  /** Whether any string inside a kept row was shortened. */
  shortened: boolean;
}

const size = (rows: unknown[]) => JSON.stringify(rows).length;

/** Shorten every string longer than `max`, however deeply nested. */
function shorten(value: unknown, max: number): unknown {
  if (typeof value === "string") {
    return value.length > max
      ? `${value.slice(0, max)}… [${value.length - max} more characters]`
      : value;
  }
  if (Array.isArray(value)) return value.map((v) => shorten(v, max));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shorten(v, max)]));
  }
  return value;
}

export function fitRows(rows: unknown[], maxChars: number): Fitted {
  if (size(rows) <= maxChars) return { rows, omitted: 0, shortened: false };

  // The most rows whose serialisation fits: binary search over the prefix.
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (size(rows.slice(0, mid)) <= maxChars) lo = mid;
    else hi = mid - 1;
  }
  if (lo > 0) return { rows: rows.slice(0, lo), omitted: rows.length - lo, shortened: false };

  // Not even one row fits: keep the first, with its long strings shortened
  // until it does.
  for (let limit = 2000; limit >= 50; limit = Math.floor(limit / 2)) {
    const first = shorten(rows[0], limit);
    if (size([first]) <= maxChars)
      return { rows: [first], omitted: rows.length - 1, shortened: true };
  }
  return { rows: [], omitted: rows.length, shortened: true };
}
