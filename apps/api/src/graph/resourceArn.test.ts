/**
 * ARNs as path parameters.
 *
 * Fastify caps a path parameter at 100 characters by default, which is a
 * routing-performance guard rather than a security control — and far too low
 * for a route whose parameter is a percent-encoded ARN, where every `:` costs
 * three characters and every `/` costs three more.
 *
 * Against a real account, clicking an IAM role returned HTTP 414 and the detail
 * panel showed nothing: service-linked roles carry an IAM path, so
 * `arn:aws:iam::…:role/aws-service-role/elasticloadbalancing.amazonaws.com/AWSServiceRoleForElasticLoadBalancing`
 * encodes to 136 characters. The remediation route has the same shape, so "How
 * to fix" was broken for exactly the admin roles it matters most for
 * (engineering log #37).
 *
 * Nothing caught it because every fixture role had a short, path-less name —
 * the longest fixture ARN encoded to 61 — and because importing the server also
 * bound a port, so no test could issue a request at all. Both are now fixed:
 * the fixture has a service-linked role, and `buildApp()` can be injected into.
 *
 * These tests exercise the **router**, not the handlers. A 404 from a resource
 * that is not in the database is a pass; a 414 is the failure being guarded
 * against.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { buildApp } from "../app.js";

let app: NestFastifyApplication;

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
});

/**
 * Issuing a request runs the handler, which reads Neo4j. That is deliberate -
 * a routing test that stubbed the handler would not prove the route is
 * reachable in the product - but it means these belong with the integration
 * suite rather than the dependency-free unit job, which has no databases and
 * would spend thirty seconds per request discovering that. Same gate the
 * ground-truth suite uses.
 *
 * The config assertion below needs nothing and runs everywhere, so the
 * regression is still caught on every commit even when the HTTP suite is
 * skipped.
 */
const HAS_INFRA = !process.env["SKIP_INTEGRATION"];

/** The shape AWS really produces for a service-linked role. */
const SERVICE_LINKED =
  "arn:aws:iam::672299759593:role/aws-service-role/elasticloadbalancing.amazonaws.com/AWSServiceRoleForElasticLoadBalancing";

const INSTANCE_PROFILE =
  "arn:aws:iam::672299759593:instance-profile/eks/production/us-east-1/nodegroups/AWSServiceRoleForAmazonEKSNodegroupWorkers";

/** An IAM path at its documented maximum is the worst legitimate case. */
const LONGEST_LEGITIMATE = `arn:aws:iam::672299759593:role/${"a/".repeat(120)}${"n".repeat(64)}`;

describe.runIf(HAS_INFRA)("a long ARN routes rather than being rejected", () => {
  it.each([
    ["a service-linked role", SERVICE_LINKED],
    ["an instance profile with a path", INSTANCE_PROFILE],
    ["an IAM path near its documented maximum", LONGEST_LEGITIMATE],
  ])("%s", async (_label, arn) => {
    /**
     * The premise, checked in **both** dimensions.
     *
     * Fastify measures the *decoded* parameter, not the encoded URL segment —
     * established by watching a 95-character ARN that encodes to 109 sail past
     * a 100-character limit. So an ARN that is only long once escaped does not
     * exercise the cap at all, and asserting on `encoded.length` alone would
     * have let a case into this suite that proves nothing.
     */
    expect(arn.length, "decoded ARN is not long enough to reach the cap").toBeGreaterThan(100);
    const encoded = encodeURIComponent(arn);
    expect(encoded.length).toBeGreaterThan(arn.length);

    const res = await app.inject({ method: "GET", url: `/api/resources/${encoded}` });
    expect(res.statusCode, `414 means the router rejected it: ${res.body.slice(0, 120)}`).not.toBe(
      414,
    );
    // Absent from the fixture is fine; being unroutable is not.
    expect([200, 404]).toContain(res.statusCode);
  });

  /** The route that suggests fixes for admin roles - the same shape, the same bug. */
  it("reaches the remediation route too", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/resources/${encodeURIComponent(SERVICE_LINKED)}/remediation`,
    });
    expect(res.statusCode).not.toBe(414);
    expect([200, 404]).toContain(res.statusCode);
  });

  it("still serves a short ARN", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/resources/${encodeURIComponent("arn:aws:s3:::northwind-public-assets")}`,
    });
    expect([200, 404]).toContain(res.statusCode);
  });
});

/**
 * The regression itself, asserted without touching a database.
 *
 * This is the guard that runs on every commit. It reads the limit off the app
 * Fastify actually built, so it fails if someone removes the option, lowers it,
 * or replaces the constructor - which is the whole regression - and it costs
 * nothing, because no request is issued.
 */
describe("the router can carry a full-length ARN", () => {
  /**
   * Read off the Fastify instance rather than the Nest app: `maxParamLength`
   * is a router setting, and the adapter is where it is configured. Asserting
   * it through the adapter also proves the Nest app is really carrying the
   * Fastify options rather than defaults of its own.
   */
  const config = () => app.getHttpAdapter().getInstance().initialConfig;

  it("configures maxParamLength above the longest legitimate IAM ARN", () => {
    // IAM: path <= 512, role name <= 64, plus the arn:aws:iam::<12>:role/
    // prefix. Fastify measures the decoded parameter, so this is the bound.
    const longestLegitimateArn = 512 + 64 + "arn:aws:iam::123456789012:role/".length;
    expect(config().maxParamLength ?? 100).toBeGreaterThan(longestLegitimateArn);
  });

  it("is not left on the default, which broke every service-linked role", () => {
    expect(config().maxParamLength).not.toBe(100);
    expect(config().maxParamLength ?? 100).toBeGreaterThan(SERVICE_LINKED.length);
  });
});

/**
 * The fixture must keep containing something long enough to have caught this.
 * Without it the suite above passes against a mock that cannot reproduce the
 * condition, which is how the bug survived in the first place.
 */
describe("the fixture can express the shape that broke", () => {
  it("seeds at least one role whose encoded ARN exceeds Fastify's default cap", async () => {
    const { GROUND_TRUTH } = await import("@daveio/mock-aws");
    // Named in the fixture rather than discovered, so deleting it fails here.
    const arn = `arn:aws:iam::123456789012:role${GROUND_TRUTH.longArnRolePath}${GROUND_TRUTH.longArnRoleName}`;
    // Decoded, because that is the length Fastify actually measures.
    expect(arn.length).toBeGreaterThan(100);
  });
});
