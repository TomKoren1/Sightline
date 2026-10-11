/**
 * Turning "who am I" into "who a trust policy can name".
 *
 * `GetCallerIdentity` reports the **session** (`arn:aws:sts::...`); a trust
 * policy's `Principal` needs the **identity** behind it (`arn:aws:iam::...`).
 * IAM rejects the former outright, and a policy that does accept one silently
 * never matches - the stack deploys and every AssumeRole fails later with
 * AccessDenied (engineering log #28).
 *
 *   sts::A:assumed-role/Role/session  ->  iam::A:role/Role
 *   sts::A:user/name                  ->  iam::A:user/name
 *   iam::A:(role|user)/...            ->  unchanged
 *
 * Everything else - federated users, account root, service principals - is not
 * assumable, and is reported rather than coerced into something plausible.
 */

/** A caller identity that a trust policy can name, or why it cannot. */
export type PrincipalResolution =
  | { ok: true; principalArn: string; converted: boolean; note?: string }
  | { ok: false; reason: string };

const ARN = /^arn:(aws[a-z-]*):(iam|sts)::(\d{12}):(.+)$/;

/**
 * Convert a caller identity ARN into the principal ARN a trust policy needs.
 *
 * Deliberately total: every input produces either a usable ARN or a sentence
 * explaining why there isn't one. Callers render that sentence rather than a
 * placeholder, because a placeholder is what sends someone to paste the wrong
 * value.
 */
export function assumablePrincipalArn(callerIdentity: string | null): PrincipalResolution {
  if (!callerIdentity) {
    return {
      ok: false,
      reason:
        "This service has no working AWS credentials, so it cannot tell you which principal to trust. Run `aws sts get-caller-identity` yourself and use the identity it reports.",
    };
  }

  const match = ARN.exec(callerIdentity.trim());
  if (!match) {
    return {
      ok: false,
      reason: `"${callerIdentity}" is not an ARN this can convert into a principal.`,
    };
  }

  const [, partition, service, account, resource] = match as unknown as [
    string,
    string,
    "iam" | "sts",
    string,
    string,
  ];

  // Already a principal ARN. Accept the two forms the template's
  // AllowedPattern accepts and nothing else - `:root` is a legitimate
  // principal but deliberately not permitted here (see ADR-007).
  if (service === "iam") {
    if (/^(role|user)\//.test(resource)) {
      return { ok: true, principalArn: callerIdentity.trim(), converted: false };
    }
    if (resource === "root") {
      return {
        ok: false,
        reason:
          "You are the account root user. Trusting the root principal would let every identity in the account assume the scanner role, which is exactly what this template exists to avoid. Create an IAM user or role for the scanner and use that.",
      };
    }
    return {
      ok: false,
      reason: `"${callerIdentity}" is an IAM ARN but not a role or user, so a trust policy cannot name it.`,
    };
  }

  // A session ARN. Convert it to the identity behind the session.
  const assumedRole = /^assumed-role\/([^/]+)\//.exec(resource);
  if (assumedRole) {
    const roleName = assumedRole[1]!;
    return {
      ok: true,
      principalArn: `arn:${partition}:iam::${account}:role/${roleName}`,
      converted: true,
      /**
       * A session ARN flattens the role's path: a role at `/team/svc/Foo`
       * still appears as `assumed-role/Foo/session`. Rebuilding it without a
       * path is right for the overwhelmingly common case and wrong for roles
       * that have one, so say so rather than quietly producing an ARN that
       * does not resolve.
       */
      note: `Converted from the session ARN reported by GetCallerIdentity. If ${roleName} was created with an IAM path, insert it before the role name.`,
    };
  }

  // moto reports `sts::<account>:user/<name>` for static credentials. Real STS
  // does not, but the conversion is unambiguous and it keeps the mock's
  // onboarding walkthrough producing a valid command.
  const user = /^user\/(.+)$/.exec(resource);
  if (user) {
    return {
      ok: true,
      principalArn: `arn:${partition}:iam::${account}:user/${user[1]!}`,
      converted: true,
      note: "Converted from an STS session ARN to the IAM user behind it.",
    };
  }

  if (resource.startsWith("federated-user/")) {
    return {
      ok: false,
      reason:
        "You are using federated credentials. A federated session has no standing IAM identity for a trust policy to name - deploy with the role or user that the federation maps to.",
    };
  }

  return {
    ok: false,
    reason: `"${callerIdentity}" is an STS ARN of a kind this cannot convert into a principal.`,
  };
}

/**
 * The pattern the CloudFormation template enforces on SightlineScannerRoleArn.
 * Kept here so the API can reject a bad value before the user discovers it as
 * a CloudFormation parameter error.
 */
export const SCANNER_PRINCIPAL_PATTERN = /^arn:aws:iam::[0-9]{12}:(role|user)\/.+$/;

/**
 * Is this ARN something `sts:AssumeRole` can actually assume?
 *
 * Only a role. This is worth checking explicitly because `AWS_TARGET_ROLE_ARN`
 * is the one variable where a *user* ARN is both plausible and useless: it is
 * what `get-caller-identity` shows on a workstation, it is the correct answer
 * for the template's scanner-principal parameter, and putting it here instead
 * produces a confusing AccessDenied much later (engineering log #28).
 */
export function validateAssumeRoleTarget(
  arn: string,
): { ok: true } | { ok: false; reason: string } {
  const match = ARN.exec(arn.trim());
  if (!match) {
    return { ok: false, reason: `AWS_TARGET_ROLE_ARN is not an IAM ARN: "${arn}"` };
  }
  const resource = match[4]!;
  if (resource.startsWith("role/")) return { ok: true };
  if (resource.startsWith("user/")) {
    return {
      ok: false,
      reason:
        `AWS_TARGET_ROLE_ARN is a user ARN ("${arn}"). sts:AssumeRole can only assume a role, so this can never work.\n` +
        "  This is almost always the two-role mix-up: a user ARN is what you give the CloudFormation template as\n" +
        "  SightlineScannerRoleArn (the principal allowed to assume), not what you put here (the role it assumes).\n" +
        "  Use the stack's RoleArn output instead - typically arn:aws:iam::<account>:role/SightlineReadOnlyRole.",
    };
  }
  return { ok: false, reason: `AWS_TARGET_ROLE_ARN must be a role ARN, got "${arn}"` };
}
