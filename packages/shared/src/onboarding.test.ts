/**
 * The recipe has to match the template it deploys, and itself.
 *
 * Three consumers share these definitions — the Connection screen, the setup
 * script and the API's diagnosis — so a drift here is a drift between all of
 * them. The specific failures these guard against have all happened:
 *
 *   - a role name that disagreed with the template's `RoleName` default leaves
 *     the reader configuring a role that does not exist (#46)
 *   - a `daveio:` prefix cannot be sent as an `sts:SourceIdentity` at all,
 *     because AWS rejects a colon in that value (#42)
 *   - a display command that differs from the executed one is two commands
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CONNECTION_ENV_KEYS,
  DAVEIO_PREFIX,
  OTHER_MANAGED_ENV_KEYS,
  READ_ONLY_ROLE_NAME,
  STACK_NAME,
  TEMPLATE_PATH,
  deployCommandArgs,
  formatDeployCommand,
  readOnlyRoleArn,
} from "./onboarding.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const template = readFileSync(root + TEMPLATE_PATH, "utf8");

const input = {
  scannerPrincipalArn: "arn:aws:iam::111122223333:user/terraform-bootstrap",
  externalId: "daveio-abc123",
  region: "us-east-1",
};

describe("the recipe agrees with the template", () => {
  it("names the role the template actually creates", () => {
    expect(template).toContain(`Default: "${READ_ONLY_ROLE_NAME}"`);
  });

  it("points at a template that exists and declares the parameters it passes", () => {
    // Both parameter names are passed by the deploy command; if the template
    // renames one, AWS rejects the whole stack.
    for (const name of ["DaveIoScannerRoleArn", "ExternalId"]) {
      expect(template, `the template does not declare ${name}`).toMatch(
        new RegExp(`^  ${name}:$`, "m"),
      );
    }
  });

  it("uses a SourceIdentity prefix AWS will accept", () => {
    // AWS permits alphanumerics, underscore and +=,.@- only. A colon here makes
    // the trust policy's StringLike unsatisfiable.
    expect(DAVEIO_PREFIX).toMatch(/^[A-Za-z0-9_+=,.@-]+$/);
    expect(template).toContain(`sts:SourceIdentity: "${DAVEIO_PREFIX}*"`);
  });

  it("builds the role ARN the template's output will report", () => {
    expect(readOnlyRoleArn("111122223333")).toBe(
      `arn:aws:iam::111122223333:role/${READ_ONLY_ROLE_NAME}`,
    );
  });
});

describe("deployCommandArgs", () => {
  it("passes the stack name, region and capability the template needs", () => {
    const args = deployCommandArgs(input);
    expect(args).toContain(STACK_NAME);
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
    const override = args.find((a) => a.startsWith("DaveIoScannerRoleArn="));
    expect(override).toBe(`DaveIoScannerRoleArn=arn:aws:iam::1:user/a"; rm -rf /; echo "`);
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
    expect(display).toMatch(/^ {6}DaveIoScannerRoleArn=.+ \\$/m);
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
