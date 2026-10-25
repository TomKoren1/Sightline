/**
 * The join from an entry point to an S3 origin goes through a regex over a
 * domain name the customer's account supplies, so it is held to two things:
 * it still recognises every endpoint shape, and no input makes it slow.
 */

import { describe, expect, it } from "vitest";
import type { Resource } from "@sightline/shared";

import { linkEntryPoints } from "./entryPoints.js";

const resource = (kind: Resource["kind"], name: string, properties = {}): Resource => ({
  arn: `arn:aws:test:::${kind}/${name}`,
  kind,
  name,
  region: "us-east-1",
  accountId: "123456789012",
  tags: {},
  properties,
  derived: {},
});

const originsTo = (domains: string[]) =>
  linkEntryPoints([
    resource("S3Bucket", "assets"),
    resource("S3Bucket", "my.dotted.bucket"),
    resource("CloudFrontDistribution", "cdn", {
      origins: domains.map((domainName, i) => ({ id: `o${i}`, domainName })),
    }),
  ]).map((l) => l.to);

describe("S3 origins", () => {
  it("recognises every endpoint shape", () => {
    expect(
      originsTo([
        "assets.s3.amazonaws.com",
        "assets.s3.eu-west-1.amazonaws.com",
        "assets.s3-website-us-east-1.amazonaws.com",
        "assets.s3-website.eu-west-1.amazonaws.com",
        "assets.s3.dualstack.us-east-1.amazonaws.com",
        "my.dotted.bucket.s3.amazonaws.com",
      ]),
    ).toEqual([
      ...Array(5).fill("arn:aws:test:::S3Bucket/assets"),
      "arn:aws:test:::S3Bucket/my.dotted.bucket",
    ]);
  });

  it("links a third-party or unknown origin to nothing", () => {
    expect(originsTo(["example.com", "other.s3.amazonaws.com", "assets.s3.example.com"])).toEqual(
      [],
    );
  });

  it("answers quickly on a domain built to backtrack", () => {
    // Before the fix, 26 labels took ~400 ms and each one more doubled it.
    const hostile = ["b.s3" + "-a".repeat(60) + ".amazonaws.co", "b.s3" + "-a".repeat(60) + "!"];
    const started = performance.now();
    expect(originsTo(hostile)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(100);
  });
});
