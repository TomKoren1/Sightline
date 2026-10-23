/**
 * Regenerate what the collector registry decides: the role template's grant
 * and the collectors' reference page. See `scan/collectors/generated.ts`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { renderCollectorDocs, withTemplateBlock } from "../scan/collectors/generated.js";
import { COLLECTORS } from "../scan/collectors/registry.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const template = `${root}infra/readonly-role.yaml`;
const docs = `${root}apps/api/src/scan/collectors/README.md`;

writeFileSync(template, withTemplateBlock(readFileSync(template, "utf8"), COLLECTORS));
writeFileSync(docs, renderCollectorDocs(COLLECTORS));
console.log(`Wrote ${template}\nWrote ${docs}`);
