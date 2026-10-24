/** The resource shape every generator reads, and the helpers they share. */

/** The resource shape these generators need — properties plus derived facts. */
export interface RemediationInput {
  arn: string;
  kind: string;
  name: string;
  region: string | null;
  properties: Record<string, unknown>;
  derived: {
    isPublic?: boolean;
    publicReason?: string;
    isUnprotected?: boolean;
    unprotectedReason?: string;
    isAdmin?: boolean;
    adminVia?: "direct" | "escalation";
    adminReason?: string;
    isIdle?: boolean;
    idleReason?: string;
    isUnused?: boolean;
    unusedReason?: string;
    estimatedMonthlyCostUsd?: number;
  };
  /** Resources that use this one, when known. Used to size the caution. */
  usedBy?: { name: string; kind: string }[];
}

export const ALL_BLOCK_SETTINGS = [
  "BlockPublicAcls",
  "IgnorePublicAcls",
  "BlockPublicPolicy",
  "RestrictPublicBuckets",
] as const;

export function blockConfig(settings: readonly string[]): string {
  return settings.map((s) => `${s}=true`).join(",");
}

/** `--region` only where the resource has one; IAM and S3 control calls do not. */
export function regionFlag(region: string | null): string {
  return region ? ` --region ${region}` : "";
}
