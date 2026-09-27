/**
 * The platform identity's permissions.
 *
 * Terraform is applied by hand against a real account, so nothing here proves
 * what is deployed. What it does prove is that the policy in the repository
 * still says what the code depends on — and the two have already drifted once
 * in the other direction, when the code refused the very key this creates.
 *
 * Read as text: `terraform validate` checks syntax, and the properties worth
 * guarding are about *scope*, which validation has no opinion about.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = fileURLToPath(new URL("../../../../infra/platform/", import.meta.url));
const iam = readFileSync(`${dir}iam_platform_user.tf`, "utf8");

describe("the platform IAM user", () => {
  it("has a policy to inspect", () => {
    expect(iam.length).toBeGreaterThan(500);
  });

  /**
   * The account must be a wildcard - every customer has a different one - but
   * the role name must not, or a stolen credential could assume any role it
   * happened to discover in any account that trusted us.
   */
  it("scopes AssumeRole to the role name the template creates", () => {
    expect(iam).toContain('"arn:aws:iam::*:role/${var.scanner_role_name}"');
    expect(iam).not.toMatch(/Resource\s*=\s*"\*"/);
  });

  it("grants only the three KMS actions the code calls", () => {
    const kmsActions = [...iam.matchAll(/"(kms:[A-Za-z]+)"/g)].map((m) => m[1]);
    expect(new Set(kmsActions)).toEqual(new Set(["kms:Encrypt", "kms:Decrypt", "kms:DescribeKey"]));
  });

  /**
   * An alias can be repointed; a policy granting on the alias ARN would follow
   * it to whatever key it names next.
   */
  it("grants on the key behind the alias, not on the alias", () => {
    expect(iam).toContain("data.aws_kms_alias.tenant_secrets.target_key_arn");
  });

  /**
   * The key belongs to another application. Terraform must look it up rather
   * than manage it, or `destroy` here would delete that application's data.
   */
  it("looks the key up rather than creating one", () => {
    expect(iam).toContain('data "aws_kms_alias"');
    expect(iam).not.toContain('resource "aws_kms_key"');
  });

  it("grants nothing else at all", () => {
    const actions = [...iam.matchAll(/"([a-z0-9]+:[A-Za-z*]+)"/g)].map((m) => m[1]);
    const unexpected = actions.filter(
      (a) => !["kms:Encrypt", "kms:Decrypt", "kms:DescribeKey", "sts:AssumeRole"].includes(a!),
    );
    expect(unexpected, "the platform identity should need nothing else").toEqual([]);
  });

  it("keeps the access key out of terraform output by default", () => {
    const outputs = readFileSync(`${dir}outputs.tf`, "utf8");
    // `sensitive` on both, so an apply cannot print them into a terminal, a
    // CI log or a screenshot.
    expect(outputs).toMatch(/platform_access_key_id[\s\S]{0,200}sensitive\s*=\s*true/);
    expect(outputs).toMatch(/platform_secret_access_key[\s\S]{0,200}sensitive\s*=\s*true/);
  });

  it("is gitignored, because state holds the secret in plaintext", () => {
    const ignored = readFileSync(
      fileURLToPath(new URL("../../../../.gitignore", import.meta.url)),
      "utf8",
    );
    expect(ignored).toContain("infra/platform/*.tfstate");
  });
});
