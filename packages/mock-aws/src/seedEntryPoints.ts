/** The production estate's front doors: load balancers, CloudFront, API Gateway. */

import {
  CreateListenerCommand,
  CreateLoadBalancerCommand,
  CreateTargetGroupCommand,
  RegisterTargetsCommand,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import { CreateDistributionCommand } from "@aws-sdk/client-cloudfront";
import { CreateApiCommand, CreateIntegrationCommand } from "@aws-sdk/client-apigatewayv2";
import { apigatewayV2, cloudfront, ec2, elbv2 } from "./clients.js";
import { PROD_REGION } from "./topology.js";
import { allowIngress } from "./seedHelpers.js";

/**
 * How the internet actually arrives: through a load balancer, a CDN, an API.
 *
 * Each adds a route into production that a host-only model cannot see, and
 * one is a trap: an internal load balancer whose group is open to the world
 * is still not reachable from it.
 */
export async function seedEntryPoints(opts: {
  vpcId: string;
  publicSubnetId: string;
  privateSubnetId: string;
  mkSg: (name: string, description: string) => Promise<string>;
  appSg: string;
  app1: string;
  orderProcessorArn: string;
}) {
  const client = ec2(PROD_REGION);
  const lb = elbv2(PROD_REGION);

  // Internet -> prod-alb -> prod-app-1 -> northwind-prod-db: a third route in.
  const albSg = await opts.mkSg("prod-alb-sg", "Public load balancer");
  await allowIngress(client, albSg, 443, { cidr: "0.0.0.0/0" }, "HTTPS from the internet");
  await allowIngress(client, opts.appSg, 9000, { groupId: albSg }, "App traffic from the ALB");
  const alb = await lb.send(
    new CreateLoadBalancerCommand({
      Name: "prod-alb",
      Subnets: [opts.publicSubnetId],
      SecurityGroups: [albSg],
      Scheme: "internet-facing",
      Type: "application",
    }),
  );
  const albArn = alb.LoadBalancers![0]!.LoadBalancerArn!;
  const tg = await lb.send(
    new CreateTargetGroupCommand({
      Name: "prod-app-tg",
      Protocol: "HTTP",
      Port: 9000,
      VpcId: opts.vpcId,
      TargetType: "instance",
    }),
  );
  const tgArn = tg.TargetGroups![0]!.TargetGroupArn!;
  await lb.send(
    new RegisterTargetsCommand({ TargetGroupArn: tgArn, Targets: [{ Id: opts.app1 }] }),
  );
  await lb.send(
    new CreateListenerCommand({
      LoadBalancerArn: albArn,
      Port: 443,
      Protocol: "HTTP",
      DefaultActions: [{ Type: "forward", TargetGroupArn: tgArn }],
    }),
  );

  // The trap: open to 0.0.0.0/0 in its group, but internal, so nothing outside
  // the VPC can reach it.
  const internalSg = await opts.mkSg("prod-internal-alb-sg", "Internal load balancer");
  await allowIngress(
    client,
    internalSg,
    443,
    { cidr: "0.0.0.0/0" },
    "Anything that can route here",
  );
  await lb.send(
    new CreateLoadBalancerCommand({
      Name: "prod-internal-alb",
      Subnets: [opts.privateSubnetId],
      SecurityGroups: [internalSg],
      Scheme: "internal",
      Type: "application",
    }),
  );

  // A CDN in front of the ALB and the public assets bucket.
  const cloudfrontDomain = cloudfront().send(
    new CreateDistributionCommand({
      DistributionConfig: {
        CallerReference: "northwind-cdn",
        Comment: "northwind-cdn",
        Enabled: true,
        Origins: {
          Quantity: 2,
          Items: [
            {
              Id: "app",
              DomainName: alb.LoadBalancers![0]!.DNSName!,
              CustomOriginConfig: {
                HTTPPort: 80,
                HTTPSPort: 443,
                OriginProtocolPolicy: "https-only",
              },
            },
            {
              Id: "assets",
              DomainName: "northwind-public-assets.s3.amazonaws.com",
              S3OriginConfig: { OriginAccessIdentity: "" },
            },
          ],
        },
        DefaultCacheBehavior: {
          TargetOriginId: "app",
          ViewerProtocolPolicy: "redirect-to-https",
          ForwardedValues: { QueryString: true, Cookies: { Forward: "all" } },
          MinTTL: 0,
          TrustedSigners: { Enabled: false, Quantity: 0 },
        },
      },
    }),
  );

  const distribution = await cloudfrontDomain;

  // Internet -> northwind-orders-api -> order-processor -> northwind-prod-db.
  const api = apigatewayV2(PROD_REGION);
  const created = await api.send(
    new CreateApiCommand({ Name: "northwind-orders-api", ProtocolType: "HTTP" }),
  );
  await api.send(
    new CreateIntegrationCommand({
      ApiId: created.ApiId!,
      IntegrationType: "AWS_PROXY",
      IntegrationUri: opts.orderProcessorArn,
      PayloadFormatVersion: "2.0",
    }),
  );

  return {
    albDns: alb.LoadBalancers![0]!.DNSName!,
    cdnDomain: distribution.Distribution!.DomainName!,
  };
}
