/**
 * CloudFront distributions, each an entry point from the whole internet.
 *
 * An origin is named by domain, not by ARN, so which load balancer or bucket
 * it is gets decided once every collector has run - see `linkEntryPoints`.
 */

import { paginateListDistributions } from "@aws-sdk/client-cloudfront";
import type { Resource } from "@sightline/shared";

import { cloudfrontClient } from "../../aws/clients.js";
import type { CollectorContext, CollectorOutput } from "./types.js";

export async function collectCloudFront(ctx: CollectorContext): Promise<CollectorOutput> {
  const client = cloudfrontClient(ctx);
  const resources: Resource[] = [];

  for await (const page of paginateListDistributions({ client }, {})) {
    for (const d of page.DistributionList?.Items ?? []) {
      if (!d.ARN || !d.Id) continue;
      resources.push({
        arn: d.ARN,
        kind: "CloudFrontDistribution",
        name: d.Comment || d.Id,
        region: null,
        accountId: ctx.accountId,
        tags: {},
        properties: {
          distributionId: d.Id,
          domainName: d.DomainName ?? null,
          enabled: d.Enabled ?? false,
          aliases: d.Aliases?.Items ?? [],
          webAclId: d.WebACLId || null,
          origins: (d.Origins?.Items ?? []).map((o) => ({
            id: o.Id ?? null,
            domainName: o.DomainName ?? null,
            kind: o.S3OriginConfig ? "s3" : "custom",
            protocolPolicy: o.CustomOriginConfig?.OriginProtocolPolicy ?? null,
          })),
        },
        derived: {},
        raw: d,
      });
    }
  }

  return { resources, relationships: [] };
}
