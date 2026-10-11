/** Rendering values of unknown type as text, without ever producing `[object Object]`. */

/** The message from anything thrown: `throw` accepts any value, so `err` is `unknown`. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  // Named, not empty: "scan failed: " reads as a bug in the logger.
  if (err === null || err === undefined) return String(err);
  return asText(err);
}

/**
 * A value out of a dynamic bag (`properties`, `derived`) as display text.
 *
 * The primitives are listed positively so the `JSON.stringify` below is the only
 * line that can stringify an object — six call sites had `String(bag[key])`,
 * which renders an object as nothing a reader can use.
 */
export function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") return "[function]";
  return JSON.stringify(value);
}
