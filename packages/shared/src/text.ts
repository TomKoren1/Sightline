/**
 * Turning values of unknown type into text, in the two places it keeps coming up.
 *
 * Both of these were previously written inline, and both had drifted into
 * several spellings that are not equivalent. The linter found the drift: three
 * of the twenty-two error sites had lost the `String(...)` on the fallback
 * branch, so they interpolated a raw `unknown` and would have rendered
 * `[object Object]` for anything thrown that was not an `Error`.
 */

/**
 * The message from anything that was thrown.
 *
 * `throw` accepts any value, so a caught `err` is `unknown` and `err.message`
 * is not available until it is narrowed. Every call site needs the same three
 * lines, which is why they had all written them slightly differently.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  /**
   * `null` and `undefined` keep their names here, unlike in `asText`.
   *
   * An empty string is a reasonable rendering of an absent *value*, and a
   * useless rendering of an absent *error*: "scan failed: " reads as a bug in
   * the logger. The words are the information.
   */
  if (err === null || err === undefined) return String(err);
  /**
   * Objects become JSON, which is a deliberate change from the `String(err)`
   * this replaced. The AWS SDK throws plain objects in some paths, and those
   * arrived in the log as `[object Object]` - a message that costs the reader
   * the entire incident. This only ever affects text that was already useless.
   */
  return asText(err);
}

/**
 * A value out of a dynamic bag, as display text.
 *
 * Resource `properties` and `derived` are `Record<string, unknown>` - they hold
 * whatever the collector put there - so `String(bag[key])` is one object away
 * from printing `[object Object]`. Objects are rendered as JSON instead, which
 * is the thing a reader can actually act on; it is also what the resource
 * detail panel was already doing inline, correctly, in one place out of six.
 *
 * Null and undefined become the empty string rather than the words "null" and
 * "undefined", because every call site was already supplying `?? ""` for that.
 */
export function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "symbol") return value.toString();
  // A function in a properties bag is data that should not be there, and its
  // source text is not what a reader needs. Named so it is recognisable.
  if (typeof value === "function") return "[function]";
  /**
   * Everything that reaches here is an object, which is the branch worth having.
   *
   * Written as a positive list of the primitives rather than a `String(value)`
   * fallback so that this is the only line that can stringify an object - the
   * whole point of the helper. A bag built from a JSON response cannot be
   * circular, so `JSON.stringify` has nothing here to throw on.
   */
  return JSON.stringify(value);
}
