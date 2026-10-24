import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";

import type { FixPlanItem } from "./api.js";
import { fixPlanScript, fixPlanTerraform } from "./fixPlan.js";

const header = {
  accountId: "123456789012",
  scanId: "scan-1",
  at: new Date("2026-10-25T00:00:00Z"),
};

const bucket: FixPlanItem = {
  arn: "arn:aws:s3:::public-assets",
  name: "public-assets",
  kind: "S3Bucket",
  region: "us-east-1",
  remediation: {
    id: "s3-enable-block-public-access",
    addresses: "public",
    title: "Re-enable Block Public Access on this bucket",
    summary: "Switches on all four settings.",
    caution: "Breaks a bucket that serves public content.",
    risk: "high",
    cli: [
      "aws s3api put-public-access-block --bucket public-assets \\",
      "  --public-access-block-configuration X",
    ],
    terraform:
      'resource "aws_s3_bucket_public_access_block" "public_assets" {\n  bucket = "public-assets"\n}',
    verify: "aws s3api get-public-access-block --bucket public-assets",
  },
};

const rule: FixPlanItem = {
  arn: "arn:aws:ec2:eu-west-1:123456789012:security-group/sg-1",
  name: "web's sg",
  kind: "SecurityGroup",
  region: "eu-west-1",
  remediation: {
    id: "sg-revoke",
    addresses: "exposed",
    title: "Revoke the rule open to the internet",
    summary: "Removes the 0.0.0.0/0 rule.",
    caution: "Cuts off\nanything relying on it.",
    risk: "medium",
    cli: ["aws ec2 revoke-security-group-ingress --region eu-west-1 --group-id sg-1"],
  },
};

/** Runs the script with a fake `aws` on PATH that prints what it was asked. */
function run(script: string, env: Record<string, string>, input = "") {
  const dir = mkdtempSync(join(tmpdir(), "fixplan-"));
  writeFileSync(join(dir, "aws"), '#!/usr/bin/env bash\necho "aws $*"\n', { mode: 0o755 });
  writeFileSync(join(dir, "plan.sh"), script);
  return spawnSync("bash", [join(dir, "plan.sh")], {
    input,
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}${delimiter}${process.env["PATH"]}`, ...env },
  });
}

describe("the fix plan script", () => {
  const script = fixPlanScript(header, [bucket, rule]);

  it("is valid bash that says where it came from and what each step risks", () => {
    expect(spawnSync("bash", ["-n"], { input: script }).status).toBe(0);
    expect(script).toContain("AWS account 123456789012, scan scan-1");
    expect(script).toContain("# 1. HIGH risk - S3Bucket public-assets (us-east-1)");
    // A newline in generator text stays inside its comment.
    expect(script).toContain("# Caution: Cuts off anything relying on it.");
  });

  it("runs every step, in order, when told yes to all", () => {
    const out = run(script, { FIX_PLAN_YES: "1" });
    expect(out.status, out.stderr).toBe(0);
    const calls = out.stdout.split("\n").filter((l) => l.startsWith("aws "));
    expect(calls).toEqual([
      "aws s3api put-public-access-block --bucket public-assets --public-access-block-configuration X",
      "aws ec2 revoke-security-group-ingress --region eu-west-1 --group-id sg-1",
    ]);
  });

  it("skips a step answered no, and anything but y is no", () => {
    const out = run(script, {}, "n\ny\n");
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).not.toContain("aws s3api");
    expect(out.stdout).toContain("aws ec2 revoke-security-group-ingress");
  });
});

describe("the fix plan Terraform", () => {
  it("declares the additive fixes in their region and lists the rest as script-only", () => {
    const tf = fixPlanTerraform(header, [bucket, bucket, rule]);
    expect(tf.included).toBe(1);
    expect(tf.scriptOnly.map((i) => i.name)).toEqual(["web's sg"]);
    expect(tf.text).toContain(
      'provider "aws" {\n  alias  = "us_east_1"\n  region = "us-east-1"\n}',
    );
    expect(tf.text).toContain(
      'resource "aws_s3_bucket_public_access_block" "public_assets" {\n  provider = aws.us_east_1\n',
    );
    expect(tf.text).toContain("Revoke the rule open to the internet - SecurityGroup web's sg");
    expect(tf.text.match(/aws_s3_bucket_public_access_block/g)).toHaveLength(1);
  });
});
