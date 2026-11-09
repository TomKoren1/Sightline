/** Rendering values of unknown type as text, without ever producing `[object Object]`. */

/** The message from anything thrown: `throw` accepts any value, so `err` is `unknown`. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return nonEmpty(err);
  // Named, not empty: "scan failed: " reads as a bug in the logger.
  if (err === null || err === undefined) return String(err);
  return asText(err);
}

/**
 * An `Error` whose `message` is empty, rendered as something a reader can use.
 *
 * `AggregateError` is the case that matters, and it is not exotic: Node throws
 * one with an empty `message` whenever a dual-stack connect exhausts every
 * address, keeping the detail in `errors` instead. A scan unit that failed that
 * way reported `Failed to read secretsmanager in ap-southeast-1:` - stopping at
 * the colon, the same class of bug as `[object Object]` above. `name` is the
 * last resort, because a bare `AggregateError` still beats "".
 */
function nonEmpty(err: Error): string {
  return detail(err) || err.name || "Error";
}

/**
 * The informative text somewhere in an error tree, or `""` if there is none.
 *
 * Separate from `nonEmpty` so the `name` fallback applies once, at the top.
 * Folded into the recursion it defeated the point: an inner `Error("")` came
 * back as `"Error"`, which is non-empty, so the search stopped there and never
 * reached the sibling holding the actual detail.
 */
function detail(err: Error): string {
  if (err.message) return err.message;
  if (err instanceof AggregateError) {
    for (const cause of err.errors) {
      const message = cause instanceof Error ? detail(cause) : asText(cause);
      if (message) return message;
    }
  }
  return "";
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
