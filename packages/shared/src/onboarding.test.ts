/**
 * The recipe has to match the template it deploys, and itself.
 *
 * Three consumers share these definitions — the Connection screen, the setup
 * script and the API's diagnosis — so a drift here is a drift between all of
 * them. The specific failures these guard against have all happened:
 *
 *   - a role name that disagreed with the template's `RoleName` default leaves
 *     the reader configuring a role that does not exist (#46)
 *   - a `sightline:` prefix cannot be sent as an `sts:SourceIdentity` at all,
 *     because AWS rejects a colon in that value (#42)
 *   - a display command that differs from the executed one is two commands
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CONNECTION_ENV_KEYS,
  SIGHTLINE_PREFIX,
  OTHER_MANAGED_ENV_KEYS,
  READ_ONLY_ROLE_NAME,
  LEGACY_SINGLE_TENANT,
  TEMPLATE_PATH,
  TEMPLATE_VERSION,
  deployCommandArgs,
  readOnlyRoleName,
  stackNameFor,
  tenantSuffix,
  formatDeployCommand,
  quickCreateUrl,
  readOnlyRoleArn,
  terraformSnippet,
} from "./onboarding.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const template = readFileSync(root + TEMPLATE_PATH, "utf8");

/** Two real-shaped tenant ids, because what matters is that they differ. */
const TENANT_A = "970bfaa9-143e-4ecd-9f27-0a1f6c92017e";
const TENANT_B = "5d1f28d8-cf62-4691-a111-d6ea8dacfa45";

const input = {
  scannerPrincipalArn: "arn:aws:iam::111122223333:user/terraform-bootstrap",
  externalId: "sightline-abc123",
  region: "us-east-1",
  tenantId: TENANT_A,
};

describe("the recipe agrees with the template", () => {
  it("names the role the template actually creates", () => {
    expect(template).toContain(`Default: "${READ_ONLY_ROLE_NAME}"`);
  });

  it("points at a template that exists and declares the parameters it passes", () => {
    // Both parameter names are passed by the deploy command; if the template
    // renames one, AWS rejects the whole stack.
    for (const name of ["SightlineScannerRoleArn", "ExternalId"]) {
      expect(template, `the template does not declare ${name}`).toMatch(
        new RegExp(`^  ${name}:$`, "m"),
      );
    }
  });

  it("uses a SourceIdentity prefix AWS will accept", () => {
    // AWS permits alphanumerics, underscore and +=,.@- only. A colon here makes
    // the trust policy's StringLike unsatisfiable.
    expect(SIGHTLINE_PREFIX).toMatch(/^[A-Za-z0-9_+=,.@-]+$/);
    expect(template).toContain(`sts:SourceIdentity: "${SIGHTLINE_PREFIX}*"`);
  });

  it("builds the role ARN the template's output will report", () => {
    expect(readOnlyRoleArn("111122223333", LEGACY_SINGLE_TENANT)).toBe(
      `arn:aws:iam::111122223333:role/${READ_ONLY_ROLE_NAME}`,
    );
  });

  it("declares the RoleName parameter the per-tenant link passes", () => {
    // The whole reason per-tenant names needed no new template version: this
    // parameter was already there, with a default and no AllowedPattern.
    expect(template).toMatch(/^ {2}RoleName:$/m);
    expect(template).toContain("RoleName: !Ref RoleName");
  });
});

describe("deployCommandArgs", () => {
  it("passes the stack name, region and capability the template needs", () => {
    const args = deployCommandArgs(input);
    expect(args).toContain(stackNameFor(TENANT_A));
    expect(args).toContain("us-east-1");
    // A named-IAM role cannot be created without it.
    expect(args).toContain("CAPABILITY_NAMED_IAM");
  });

  it("is a vector, so nothing is interpreted by a shell", () => {
    // The point of the vector: an account id containing a quote is a value, not
    // syntax. Asserted by giving it one.
    const args = deployCommandArgs({
      ...input,
      scannerPrincipalArn: `arn:aws:iam::1:user/a"; rm -rf /; echo "`,
    });
    const override = args.find((a) => a.startsWith("SightlineScannerRoleArn="));
    expect(override).toBe(`SightlineScannerRoleArn=arn:aws:iam::1:user/a"; rm -rf /; echo "`);
    // And it stays one argument rather than becoming several.
    expect(args.filter((a) => a.includes("rm -rf"))).toHaveLength(1);
  });

  it("omits --profile when there is none, and includes it when there is", () => {
    expect(deployCommandArgs(input)).not.toContain("--profile");
    const withProfile = deployCommandArgs({ ...input, profile: "work" });
    expect(withProfile).toContain("--profile");
    expect(withProfile[withProfile.indexOf("--profile") + 1]).toBe("work");
  });
});

describe("formatDeployCommand", () => {
  it("renders every argument the vector carries", () => {
    const display = formatDeployCommand(input);
    for (const arg of deployCommandArgs(input)) {
      expect(display, `the display form omits ${arg}`).toContain(arg);
    }
  });

  it("is a single pasteable command", () => {
    const display = formatDeployCommand(input);
    // `aws cloudformation deploy \` - the subcommand words share the first line,
    // which is the shape every AWS example uses. Asserted as "starts with the
    // command" rather than as an exact prefix, which is what the first version of
    // this did and why it failed on a formatting improvement.
    expect(display.startsWith("aws ")).toBe(true);
    expect(display.split("\n")[0]).toBe("aws cloudformation deploy \\");
    // Every line but the last continues; the last must not, or a paste hangs
    // waiting for more input.
    const lines = display.split("\n");
    for (const line of lines.slice(0, -1)) expect(line.endsWith("\\")).toBe(true);
    expect(lines[lines.length - 1]!.endsWith("\\")).toBe(false);
  });

  it("puts the substitutable values on their own lines", () => {
    // Readers edit the parameter overrides; they should not have to find them
    // inside a longer line.
    const display = formatDeployCommand(input);
    expect(display).toMatch(/^ {6}SightlineScannerRoleArn=.+ \\$/m);
    expect(display).toMatch(/^ {6}ExternalId=.+$/m);
  });
});

describe("the managed env keys", () => {
  it("does not claim to manage the same key twice", () => {
    const all = [...CONNECTION_ENV_KEYS, ...OTHER_MANAGED_ENV_KEYS];
    expect(new Set(all).size, `duplicate key in the managed lists: ${all.join(", ")}`).toBe(
      all.length,
    );
  });

  it("never claims to manage a credential", () => {
    /**
     * The setup script rewrites these keys. Access keys must not be among them:
     * the script asks for a *profile* or leaves credentials alone, so that a
     * long-lived secret is never written to a file by automation the user
     * cannot see.
     */
    const all = [...CONNECTION_ENV_KEYS, ...OTHER_MANAGED_ENV_KEYS] as string[];
    expect(all).not.toContain("AWS_ACCESS_KEY_ID");
    expect(all).not.toContain("AWS_SECRET_ACCESS_KEY");
    expect(all).not.toContain("AWS_SESSION_TOKEN");
  });
});

const published = {
  templateUrl: "https://sightline-templates.s3.amazonaws.com/v1/readonly-role.yaml",
  scannerPrincipalArn: input.scannerPrincipalArn,
  externalId: input.externalId,
  region: "us-east-1",
  tenantId: TENANT_A,
};

describe("the one-click link", () => {
  it("puts the parameters in the fragment, where the console reads them", () => {
    const url = quickCreateUrl(published);
    // Not the real query string: the console's own router parses the fragment,
    // and parameters placed before the `#` do nothing at all.
    const [, fragment] = url.split("#");
    expect(fragment).toBeDefined();
    expect(fragment).toContain("param_ExternalId=");
    expect(fragment).toContain("param_SightlineScannerRoleArn=");
    expect(url.split("#")[0]).not.toContain("param_");
  });

  it("pre-fills every parameter the template requires", () => {
    const fragment = quickCreateUrl(published).split("#")[1]!;
    const params = new URLSearchParams(fragment.slice(fragment.indexOf("?") + 1));
    expect(params.get("param_ExternalId")).toBe(input.externalId);
    expect(params.get("param_SightlineScannerRoleArn")).toBe(input.scannerPrincipalArn);
    expect(params.get("templateURL")).toBe(published.templateUrl);
    expect(params.get("stackName")).toBe(stackNameFor(TENANT_A));
  });

  it("names every template parameter that has no default", () => {
    /**
     * The check that makes the link worth having.
     *
     * A parameter without a default and without a value in the link leaves the
     * customer staring at an empty required field - which is the step they
     * abandon. Read from the template rather than listed here, so adding a
     * required parameter fails this test instead of quietly degrading
     * onboarding.
     */
    const parameterBlock = template.slice(
      template.indexOf("\nParameters:"),
      template.indexOf("\nConditions:"),
    );
    /**
     * Sliced between consecutive parameter headers.
     *
     * Not by searching forward for the next two-space indent: `"\n  "` is also
     * a prefix of every four-space nested line, so each body came out empty and
     * every parameter looked as though it had no default.
     */
    const headers = [...parameterBlock.matchAll(/^ {2}(\w+):$/gm)];
    const required = headers
      .filter((header, i) => {
        const from = header.index + header[0].length;
        const to = headers[i + 1]?.index ?? parameterBlock.length;
        return !/^\s+Default:/m.test(parameterBlock.slice(from, to));
      })
      .map((header) => header[1]!);

    const fragment = quickCreateUrl(published).split("#")[1]!;
    const params = new URLSearchParams(fragment.slice(fragment.indexOf("?") + 1));
    expect(required.length).toBeGreaterThan(0);
    for (const name of required) {
      expect(
        params.get(`param_${name}`),
        `${name} has no default and is not pre-filled`,
      ).toBeTruthy();
    }
  });

  it("survives a template URL full of slashes and colons", () => {
    // Encoded value by value rather than through URLSearchParams, which turns
    // `/` and `:` into a form the console does not unpick.
    const url = quickCreateUrl(published);
    expect(url).toContain(encodeURIComponent(published.templateUrl));
    expect(url).not.toContain(
      "https://sightline-templates.s3.amazonaws.com/v1/readonly-role.yaml&",
    );
  });

  it("lands in the console for the region the stack is created in", () => {
    const url = quickCreateUrl({ ...published, region: "eu-west-1" });
    expect(url.startsWith("https://eu-west-1.console.aws.amazon.com/")).toBe(true);
    expect(url).toContain("?region=eu-west-1");
  });
});

describe("the Terraform form", () => {
  it("deploys the same stack, with the same parameters", () => {
    const snippet = terraformSnippet(published);
    expect(snippet).toContain(`name         = "${stackNameFor(TENANT_A)}"`);
    expect(snippet).toContain(`ExternalId              = "${input.externalId}"`);
    expect(snippet).toContain(`SightlineScannerRoleArn = "${input.scannerPrincipalArn}"`);
    // The acknowledgement the console asks for as a checkbox.
    expect(snippet).toContain("CAPABILITY_NAMED_IAM");
  });

  it("outputs the ARN the customer has to send back", () => {
    expect(terraformSnippet(published)).toContain('outputs["RoleArn"]');
  });

  it("is a valid resource name, which the stack name is not", () => {
    // `sightline-readonly` has a hyphen; a Terraform identifier cannot.
    expect(terraformSnippet(published)).not.toMatch(/resource "[^"]+" "[a-z_]*-/);
  });
});

describe("the template version", () => {
  it("is recorded so a stale deployment is detected rather than diagnosed", () => {
    // The failure it exists for: a role deployed from an older template matched
    // a SourceIdentity pattern no legal value could satisfy, and the assume was
    // refused with an AccessDenied that mentioned nothing relevant.
    expect(TEMPLATE_VERSION).toMatch(/^v\d+$/);
  });
});

describe("per-tenant names", () => {
  /**
   * The defect these exist for, stated once: an AWS account holds one role of a
   * given name, that role has one trust policy, and a trust policy carries one
   * ExternalId. Two tenants naming the same role therefore could not both
   * connect one account - whichever deployed last owned it, and the other was
   * refused for ever with "the role exists but refused to be assumed", which
   * reads as a broken deployment rather than as a collision.
   *
   * Found by connecting the same account from two Google accounts on a live
   * deployment, twice, after a day of diagnosing it as an ExternalId mismatch.
   */
  it("gives two tenants different names in the same account", () => {
    expect(readOnlyRoleName(TENANT_A)).not.toBe(readOnlyRoleName(TENANT_B));
    expect(stackNameFor(TENANT_A)).not.toBe(stackNameFor(TENANT_B));
    expect(readOnlyRoleArn("111122223333", TENANT_A)).not.toBe(
      readOnlyRoleArn("111122223333", TENANT_B),
    );
  });

  it("gives one tenant the same name every time", () => {
    // Derived, not stored: the name has to come out identical on the screen
    // that shows the link, the row that pins the ARN, and the verify that
    // assumes it.
    expect(readOnlyRoleName(TENANT_A)).toBe(readOnlyRoleName(TENANT_A));
    expect(readOnlyRoleName(TENANT_A.toUpperCase())).toBe(readOnlyRoleName(TENANT_A));
  });

  it("leaves the single-tenant deployment's names exactly as they were", () => {
    /**
     * Not cosmetic. A clone's `.env` holds the role ARN it deployed, and
     * `npm run setup --disconnect` deletes that role *by name* - so changing
     * the name here would orphan every role already deployed and make the
     * teardown silently delete nothing.
     */
    expect(readOnlyRoleName(LEGACY_SINGLE_TENANT)).toBe("SightlineReadOnlyRole");
    expect(stackNameFor(LEGACY_SINGLE_TENANT)).toBe("sightline-readonly");
  });

  it("fits what AWS will accept as a role name", () => {
    // 64 characters, and only these characters. A name AWS rejects fails at
    // stack-create time, in the customer's console, after they have agreed to
    // the IAM acknowledgement.
    for (const tenant of [TENANT_A, TENANT_B, LEGACY_SINGLE_TENANT]) {
      const name = readOnlyRoleName(tenant);
      expect(name.length, name).toBeLessThanOrEqual(64);
      expect(name, name).toMatch(/^[A-Za-z0-9+=,.@_-]+$/);
      // And a stack name: letters, digits and hyphens, starting with a letter.
      expect(stackNameFor(tenant)).toMatch(/^[A-Za-z][A-Za-z0-9-]{0,127}$/);
    }
  });

  it("refuses anything that is not a tenant id", () => {
    /**
     * Rather than naming a customer's role after a typo. The empty string is
     * the one that matters: it is what an unset variable looks like, and
     * `SightlineReadOnlyRole-` would deploy, work, and collide with every
     * other caller that passed nothing.
     */
    for (const bad of ["", "   ", "tenant-1", "ZZZZ"]) {
      expect(() => tenantSuffix(bad), JSON.stringify(bad)).toThrow(/tenant id/);
      expect(() => readOnlyRoleName(bad), JSON.stringify(bad)).toThrow(/tenant id/);
    }
  });

  it("names the same role in the link, the CLI command and the Terraform", () => {
    /**
     * The cross-artefact check this file exists for, extended to the new
     * parameter. Three things a customer might each use, one of which being
     * wrong means the role they deploy is not the one that gets assumed - and
     * the symptom is an AccessDenied naming nothing.
     */
    const role = readOnlyRoleName(TENANT_B);
    const stack = stackNameFor(TENANT_B);
    const forB = { ...published, tenantId: TENANT_B };

    const fragment = quickCreateUrl(forB).split("#")[1]!;
    const params = new URLSearchParams(fragment.slice(fragment.indexOf("?") + 1));
    expect(params.get("param_RoleName")).toBe(role);
    expect(params.get("stackName")).toBe(stack);

    const args = deployCommandArgs({ ...input, tenantId: TENANT_B });
    expect(args).toContain(`RoleName=${role}`);
    expect(args[args.indexOf("--stack-name") + 1]).toBe(stack);

    const snippet = terraformSnippet(forB);
    expect(snippet).toContain(`RoleName                = "${role}"`);
    expect(snippet).toContain(`name         = "${stack}"`);
  });
});
