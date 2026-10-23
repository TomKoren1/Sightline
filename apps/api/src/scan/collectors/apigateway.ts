/**
 * API Gateway: REST APIs (v1) and HTTP and WebSocket APIs (v2).
 *
 * An API that is not private is reachable from the internet, and its
 * integrations are what it reaches: usually a Lambda function, sometimes a
 * load balancer through a VPC link. Integrations naming a URL are kept as
 * properties and matched to a resource by domain in `linkEntryPoints`.
 */

import { GetResourcesCommand, paginateGetRestApis } from "@aws-sdk/client-api-gateway";
import { GetApisCommand, GetIntegrationsCommand, type Api } from "@aws-sdk/client-apigatewayv2";
import type { Relationship, Resource } from "@sightline/shared";

import { apigatewayClient, apigatewayV2Client } from "../../aws/clients.js";
import { regionArn } from "../../aws/arns.js";
import type { CollectorContext, CollectorOutput } from "./types.js";

export interface Integration {
  type: string | null;
  uri: string | null;
  connectionType: string | null;
}

/** The Lambda ARN inside an integration URI, in either of its two spellings. */
export function lambdaFromUri(uri: string | null): string | null {
  if (!uri) return null;
  const wrapped = /\/functions\/(arn:aws[\w-]*:lambda:[^/]+)\/invocations/.exec(uri);
  if (wrapped) return wrapped[1]!;
  return /^arn:aws[\w-]*:lambda:[^:]+:\d+:function:[^:/]+/.exec(uri)?.[0] ?? null;
}

/** The load balancer behind a listener ARN: `listener/app/x/id/lid` -> `loadbalancer/app/x/id`. */
export function loadBalancerFromListener(uri: string | null): string | null {
  const m =
    /^(arn:aws[\w-]*:elasticloadbalancing:[^:]+:\d+:)listener\/((?:app|net)\/[^/]+\/[^/]+)\/[^/]+$/.exec(
      uri ?? "",
    );
  return m ? `${m[1]}loadbalancer/${m[2]}` : null;
}

export async function collectApiGateway(ctx: CollectorContext): Promise<CollectorOutput> {
  const region = ctx.region!;
  const v1 = apigatewayClient(ctx, region);
  const v2 = apigatewayV2Client(ctx, region);
  const resources: Resource[] = [];
  const relationships: Relationship[] = [];

  const record = (
    arn: string,
    name: string,
    props: { apiType: string; endpointType: string | null; endpoint: string | null },
    integrations: Integration[],
    raw: unknown,
  ) => {
    resources.push({
      arn,
      kind: "ApiGateway",
      name,
      region,
      accountId: ctx.accountId,
      tags: {},
      properties: { ...props, isPrivate: props.endpointType === "PRIVATE", integrations },
      derived: {},
      raw,
    });
    relationships.push({ from: arn, to: regionArn(ctx.accountId, region), type: "IN_REGION" });
    for (const integration of integrations) {
      const to = lambdaFromUri(integration.uri) ?? loadBalancerFromListener(integration.uri);
      if (to) {
        relationships.push({
          from: arn,
          to,
          type: "INTEGRATES_WITH",
          properties: { integrationType: integration.type },
        });
      }
    }
  };

  for await (const page of paginateGetRestApis({ client: v1 }, {})) {
    for (const api of page.items ?? []) {
      if (!api.id || !api.name) continue;
      const integrations: Integration[] = [];
      let position: string | undefined;
      do {
        const res = await v1.send(
          new GetResourcesCommand({ restApiId: api.id, embed: ["methods"], position }),
        );
        for (const resource of res.items ?? []) {
          for (const method of Object.values(resource.resourceMethods ?? {})) {
            const i = method.methodIntegration;
            if (i) {
              integrations.push({
                type: i.type ?? null,
                uri: i.uri ?? null,
                connectionType: i.connectionType ?? null,
              });
            }
          }
        }
        position = res.position;
      } while (position);
      record(
        `arn:aws:apigateway:${region}::/restapis/${api.id}`,
        api.name,
        {
          apiType: "REST",
          endpointType: api.endpointConfiguration?.types?.[0] ?? null,
          endpoint: `https://${api.id}.execute-api.${region}.amazonaws.com`,
        },
        integrations,
        api,
      );
    }
  }

  const apis: Api[] = [];
  let next: string | undefined;
  do {
    const res = await v2.send(new GetApisCommand({ NextToken: next }));
    apis.push(...(res.Items ?? []));
    next = res.NextToken;
  } while (next);

  for (const api of apis) {
    if (!api.ApiId || !api.Name) continue;
    const integrations: Integration[] = [];
    let token: string | undefined;
    do {
      const res = await v2.send(new GetIntegrationsCommand({ ApiId: api.ApiId, NextToken: token }));
      for (const i of res.Items ?? []) {
        integrations.push({
          type: i.IntegrationType ?? null,
          uri: i.IntegrationUri ?? null,
          connectionType: i.ConnectionType ?? null,
        });
      }
      token = res.NextToken;
    } while (token);
    record(
      `arn:aws:apigateway:${region}::/apis/${api.ApiId}`,
      api.Name,
      {
        apiType: api.ProtocolType ?? "HTTP",
        // v2 APIs are regional and public; a private one is reached only
        // through a VPC endpoint, which v2 does not offer.
        endpointType: "REGIONAL",
        endpoint: api.ApiEndpoint ?? null,
      },
      integrations,
      api,
    );
  }

  return { resources, relationships };
}
