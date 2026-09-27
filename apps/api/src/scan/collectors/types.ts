/** The contract every service collector implements. */

import type { Relationship, Resource } from "@daveio/shared";
import type { TenantId } from "../../tenancy/tenant.js";

export interface CollectorContext {
  /** `null` for global services. */
  region: string | null;
  accountId: string;
  /**
   * Whose account this is.
   *
   * Carried explicitly so every AWS client a collector builds has to name the
   * tenant it is talking to. Ambient credentials are how one tenant's scan
   * reads another tenant's account (ADR-019).
   */
  tenantId: TenantId;
  /**
   * Where this tenant's calls go: null for real AWS, the demo fixture's URL
   * when they are looking at the demo account. Explicit for the same reason
   * the tenant is (ADR-019, ADR-020).
   */
  endpoint: string | null;
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
