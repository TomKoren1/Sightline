/**
 * Each collector's output for the demo account, recorded from moto and
 * committed, so analysis and the tier-1 checks run with no databases and no
 * mock: in the fast CI job, and on a laptop with nothing started.
 *
 * Recorded by `npm run gen:fixtures`, which seeds the mock first. moto mints
 * new ids on every seed, so freshness is checked by
 * shape - which resources, by kind and name, and how many of each relationship
 * - not byte for byte (`contract.test.ts`).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Relationship, Resource, ScannableService } from "@sightline/shared";

import type { CollectorOutput } from "./types.js";

const DIR = fileURLToPath(new URL("./fixtures/", import.meta.url));
const file = (service: string) => `${DIR}${service}.json`;

export interface Fixture extends CollectorOutput {
  accountId: string;
  regions: string[];
}

const byArn = (a: { arn: string }, b: { arn: string }) => a.arn.localeCompare(b.arn);
const edgeKey = (r: Relationship) => `${r.from}|${r.type}|${r.to}`;

/** One service's units merged, `raw` dropped (no analyser reads it), stably ordered. */
export function toFixture(
  outputs: CollectorOutput[],
  accountId: string,
  regions: string[],
): Fixture {
  const resources = outputs
    .flatMap((o) => o.resources)
    .map(({ raw: _raw, ...rest }: Resource) => rest as Resource)
    .sort(byArn);
  const relationships = outputs
    .flatMap((o) => o.relationships)
    .sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));
  return { accountId, regions, resources, relationships };
}

export function writeFixture(service: ScannableService, fixture: Fixture): void {
  writeFileSync(file(service), `${JSON.stringify(fixture, null, 1)}\n`);
}

export function readFixture(service: ScannableService): Fixture {
  return JSON.parse(readFileSync(file(service), "utf8")) as Fixture;
}

/** What the fixture is, independent of the ids moto happened to mint. */
export function shapeOf(output: CollectorOutput) {
  const counts: Record<string, number> = {};
  for (const r of output.relationships) counts[r.type] = (counts[r.type] ?? 0) + 1;
  return {
    // A resource with no Name tag is named by its id or address, which moto
    // mints anew on every seed, so those are not part of the shape.
    resources: output.resources
      .map((r) => {
        const name = r.name
          .replace(/\d{1,3}(\.\d{1,3}){3}/g, "#") // an address: elastic IPs
          .replace(/[0-9a-f]{8,}(-[0-9a-f]{4,})*/gi, "#");
        return `${r.kind}:${name}`;
      })
      .sort(),
    relationships: counts,
  };
}
