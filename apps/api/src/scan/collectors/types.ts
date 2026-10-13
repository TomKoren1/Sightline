/** The contract every service collector implements. */

import type { Relationship, Resource } from "@sightline/shared";

import type { AwsContext } from "../../aws/clients.js";

/**
 * Extends `AwsContext`, so a collector cannot build a client without naming
 * whose account it will talk to - the context it already has is the context the
 * client factories require.
 */
export interface CollectorContext extends AwsContext {
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
