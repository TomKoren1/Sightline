/**
 * Joining entry points to what they front, by domain name.
 *
 * A CloudFront origin and an API's HTTP integration name their backend by
 * domain, not ARN, and that backend comes from a different collector. Once
 * every collector has run, a load balancer's DNS name and a bucket's endpoint
 * are known, and the join is a lookup. A domain this account does not own -
 * a third-party origin - links to nothing, which is the right answer.
 */

import type { Relationship, Resource } from "@sightline/shared";

/** `bucket.s3.amazonaws.com`, `bucket.s3.eu-west-1.amazonaws.com`, website endpoints. */
const S3_DOMAIN = /^(.+?)\.s3(?:[.-][a-z0-9-]+)*\.amazonaws\.com$/i;

function hostOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function linkEntryPoints(resources: Resource[]): Relationship[] {
  const byHost = new Map<string, string>();
  for (const r of resources) {
    if (r.kind === "LoadBalancer") {
      const host = hostOf(r.properties["dnsName"] as string | null);
      if (host) byHost.set(host, r.arn);
    }
  }
  const buckets = new Map(
    resources.filter((r) => r.kind === "S3Bucket").map((r) => [r.name, r.arn]),
  );

  const resolve = (domain: string | null | undefined): string | null => {
    const host = hostOf(domain);
    if (!host) return null;
    const lb = byHost.get(host);
    if (lb) return lb;
    const bucket = S3_DOMAIN.exec(host)?.[1];
    return bucket ? (buckets.get(bucket) ?? null) : null;
  };

  const links: Relationship[] = [];
  for (const r of resources) {
    if (r.kind === "CloudFrontDistribution") {
      const origins = (r.properties["origins"] ?? []) as {
        id: string | null;
        domainName: string | null;
      }[];
      for (const origin of origins) {
        const to = resolve(origin.domainName);
        if (to)
          links.push({ from: r.arn, to, type: "HAS_ORIGIN", properties: { originId: origin.id } });
      }
    }
    if (r.kind === "ApiGateway") {
      const integrations = (r.properties["integrations"] ?? []) as {
        type: string | null;
        uri: string | null;
      }[];
      for (const integration of integrations) {
        if (!integration.uri?.startsWith("http")) continue;
        const to = resolve(integration.uri);
        if (to) {
          links.push({
            from: r.arn,
            to,
            type: "INTEGRATES_WITH",
            properties: { integrationType: integration.type },
          });
        }
      }
    }
  }
  return links;
}
