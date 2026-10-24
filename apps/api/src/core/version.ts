/**
 * The running version, read from `package.json` rather than retyped.
 *
 * A second copy of a version number is a copy that disagrees, and the one that
 * disagrees is the one in the metric nobody checks. `with { type: "json" }` is
 * the standard ESM import attribute, supported by both tsx and the bundler.
 */

import pkg from "../../package.json" with { type: "json" };

export const VERSION: string = pkg.version;
