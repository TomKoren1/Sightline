/**
 * ARN construction and tag normalisation.
 *
 * Most EC2 APIs return bare ids (`vpc-0abc`, `i-0def`) rather than ARNs, but
 * the graph needs one stable identity per resource. We build the ARN AWS would
 * have used, so an id minted here matches one that arrives from a service
 * which does return ARNs (RDS, Lambda, IAM) and the two join correctly.
 */

export const PARTITION = "aws";

export const ec2Arn = (region: string, account: string, type: string, id: string) =>
  `arn:${PARTITION}:ec2:${region}:${account}:${type}/${id}`;

export const s3Arn = (bucket: string) => `arn:${PARTITION}:s3:::${bucket}`;

export const iamArn = (account: string, type: string, name: string) =>
  `arn:${PARTITION}:iam::${account}:${type}/${name}`;

export const rdsArn = (region: string, account: string, type: string, id: string) =>
  `arn:${PARTITION}:rds:${region}:${account}:${type}:${id}`;

export const lambdaArn = (region: string, account: string, name: string) =>
  `arn:${PARTITION}:lambda:${region}:${account}:function:${name}`;

/** Region node identity - synthetic, but the graph needs to hang things off it. */
export const regionArn = (account: string, region: string) =>
  `arn:${PARTITION}:daveio:${region}:${account}:region/${region}`;

export const accountArn = (account: string) => `arn:${PARTITION}:daveio:::account/${account}`;

/** AWS tag lists come in several shapes; normalise them all to a record. */
export function tagsToRecord(
  tags: Array<{ Key?: string; Value?: string }> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of tags ?? []) {
    if (t.Key) out[t.Key] = t.Value ?? "";
  }
  return out;
}

/** The `Name` tag, falling back to the resource id. */
export function nameFromTags(tags: Record<string, string>, fallback: string): string {
  return tags["Name"] ?? fallback;
}
