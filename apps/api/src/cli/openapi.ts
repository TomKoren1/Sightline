#!/usr/bin/env tsx
/** Rewrite docs/openapi.json from the contract list. See src/openapi.ts. */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { openApiJson } from "../http/openapi.js";

const target = fileURLToPath(new URL("../../../../docs/openapi.json", import.meta.url));
writeFileSync(target, openApiJson());
console.log(`Wrote ${target}`);
