/** The contract every service collector implements. */

import type { Relationship, Resource } from "@sightline/shared";

export interface CollectorContext {
  /** `null` for global services. */
  region: string | null;
  accountId: string;
}

export interface CollectorOutput {
  resources: Resource[];
  relationships: Relationship[];
}

export type Collector = (ctx: CollectorContext) => Promise<CollectorOutput>;

export const empty = (): CollectorOutput => ({ resources: [], relationships: [] });

/** Merge collector outputs, preserving order. */
export function mergeOutputs(outputs: CollectorOutput[]): CollectorOutput {
  const resources: Resource[] = [];
  const relationships: Relationship[] = [];
  for (const o of outputs) {
    resources.push(...o.resources);
    relationships.push(...o.relationships);
  }
  return { resources, relationships };
}
