/**
 * Translating a failed AssumeRole into the specific thing to fix.
 *
 * Its own module because two paths need it: the single-operator connection test
 * that has always had it, and the per-connection verification the onboarding
 * flow polls. A second copy would be a second set of messages, and these
 * messages are the whole value - "AccessDenied" is accurate and useless, while
 * "the trust policy does not name this principal" is actionable.
 */

import { credentialSources, sourceIdentity } from "../config.js";
import { errorMessage } from "@sightline/shared";

export interface Diagnosis {
  code: string;
  problem: string;
  fix: string;
}

/**
 * Where the reader should go to compare the ExternalId.
 *
 * It said `AWS_EXTERNAL_ID` unconditionally, which was right when the only
 * reader was an operator with a `.env` in front of them. Sent to a customer it
 * names a file they do not have, on a machine they cannot see - and being
 * specific about what to check is this message's entire value.
 */
export type ExternalIdLocation = "env" | "connect-screen";

const WHERE_TO_LOOK: Record<ExternalIdLocation, string> = {
  env: "Check that AWS_EXTERNAL_ID here is byte-identical to the value used when the stack was deployed.",
  "connect-screen":
    "Compare the ExternalId on the Connect screen with the one in your deployed stack - they have to " +
    "be byte-identical. If they differ, redeploy the stack with the value shown there.",
};

/**
 * Translate a failed AssumeRole into the specific thing to fix.
 *
 * This is the whole value of a connection test. "AccessDenied" is accurate and
 * useless; "the trust policy does not name this principal" is actionable.
 */
export function diagnose(
  err: unknown,
  callerIdentity?: string | null,
  externalIdLocation: ExternalIdLocation = "env",
): Diagnosis {
  const name = err instanceof Error ? err.name : "UnknownError";
  const message = errorMessage(err);

  if (name === "AccessDenied" || message.includes("not authorized to perform: sts:AssumeRole")) {
    /**
     * Name the principal rather than describing it.
     *
     * "The trust policy does not name this principal" is true and still leaves
     * the reader to work out which principal that is - and the answer is
     * frequently not the one they assumed, because the host's ambient
     * credentials need not be the identity they had in mind when they deployed
     * the stack. We know exactly who we are, so say it, and give the command
     * that fixes it.
     */
    const identity = callerIdentity
      ? `\n  This backend is authenticating as ${callerIdentity}. The stack's trust policy has to name exactly that principal, ` +
        "so if it was deployed with a different one, redeploy with " +
        `SightlineScannerRoleArn=${callerIdentity}, or give this host credentials for the principal it does name. ` +
        "Check with: aws iam get-role --role-name SightlineReadOnlyRole --query 'Role.AssumeRolePolicyDocument'"
      : "";

    /**
     * A third cause, and now the most likely one for an existing deployment.
     *
     * Every AssumeRole sets `sts:SourceIdentity`. A stack deployed
     * before that became mandatory carries `StringLike sts:SourceIdentity:
     * "sightline:*"` - a pattern no legal value can match, because AWS forbids a
     * colon in SourceIdentity - so `sts:SetSourceIdentity` is denied and the
     * whole AssumeRole fails. The denial says nothing about SourceIdentity, and
     * the obvious reading is that the ExternalId or the principal is wrong, so
     * naming it here saves an hour of looking in the wrong place.
     */
    const sourceIdentityHint =
      "\n  If this role was deployed before SourceIdentity became mandatory, its trust policy still matches " +
      `"sightline:*" while the scanner now sends "${sourceIdentity()}" - a colon is not legal in a SourceIdentity, ` +
      "so that condition can never match and the assume is refused. Redeploy the stack from the current " +
      "template to fix it; the Connect screen shows the exact link and command.";
    return {
      code: name,
      problem: "The role exists but refused to be assumed.",
      fix:
        "Usually one of three things: the trust policy does not name this principal, the ExternalId does not match, " +
        "or the stack predates SourceIdentity being required. " +
        WHERE_TO_LOOK[externalIdLocation] +
        identity +
        sourceIdentityHint,
    };
  }
  if (message.includes("ExternalId") || message.includes("external id")) {
    return {
      code: name,
      problem: "The ExternalId was rejected.",
      fix: "Redeploy the stack with the ExternalId shown below, or correct AWS_EXTERNAL_ID to match the deployed value.",
    };
  }
  if (name === "NoSuchEntity" || message.includes("cannot be found")) {
    return {
      code: name,
      problem: "No role exists at that ARN.",
      fix: "Confirm the CloudFormation stack deployed successfully, and that AWS_TARGET_ROLE_ARN matches its RoleArn output.",
    };
  }
  if (name === "InvalidClientTokenId" || name === "UnrecognizedClientException") {
    return {
      code: name,
      problem: "The credentials this service is using were rejected by AWS.",
      fix: "These are the source credentials used to call AssumeRole, not the customer's. Check the host's own AWS credentials.",
    };
  }
  if (name === "CredentialsProviderError" || name === "CredentialsError") {
    /**
     * Say which link of the chain is missing, not that the chain failed.
     *
     * "Provide credentials" is true and useless: in a container there are two
     * plausible causes needing opposite fixes, and the reader cannot see inside
     * the container to tell which applies. This reports what was actually
     * checked.
     */
    const src = credentialSources();
    const checked: string[] = [];

    if (!src.envKeySet) {
      checked.push("AWS_ACCESS_KEY_ID is not set");
    } else if (src.envKeyIsMockPlaceholder) {
      // The decisive case: nothing was replaced, so say that rather than
      // describing the shape of a value the reader never chose.
      checked.push(
        'AWS_ACCESS_KEY_ID is still the placeholder "mock" that .env.example ships — it has not ' +
          "been replaced, and it is removed at startup so it cannot shadow the rest of the chain",
      );
    } else if (!src.envKeyLooksReal) {
      checked.push(
        `AWS_ACCESS_KEY_ID is set (${src.envKeyLength} characters) but does not start AKIA or ASIA, ` +
          "so it is not a real key id and was removed. Check you pasted the access key id rather " +
          "than the secret, and that none of it is missing",
      );
    } else {
      checked.push("AWS_ACCESS_KEY_ID looks real, so the failure is elsewhere");
    }

    if (src.profileFiles.length > 0) {
      checked.push(`a profile directory was found containing ${src.profileFiles.join(", ")}`);
    } else if (src.profileDirExists) {
      // Distinguished because it points at a different fix: the mount happened
      // and landed on the wrong host path.
      checked.push(
        "a ~/.aws directory exists but is EMPTY, which means the mount resolved to the wrong host " +
          "path - on Windows that is an unset HOME, so set AWS_PROFILE_DIR",
      );
    } else {
      checked.push(`no profile directory at ${src.profileDir}, so no profile was mounted there`);
    }

    const fix = src.containerised
      ? "This API is running in a container, so the host's credentials do not reach it by default. " +
        "Mount your ~/.aws profile by adding these two lines to .env: " +
        "COMPOSE_PATH_SEPARATOR=: and COMPOSE_FILE=docker-compose.yml:deploy/compose.aws-profile.yml " +
        "(or set real values for AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY instead). " +
        "Then recreate it with `docker compose --profile app up -d api` - `restart` reuses the old " +
        `environment. If those lines are already set, the mount is landing somewhere this container ` +
        `does not read: it runs as the \`node\` user, so the profile must arrive at ${src.profileDir}.`
      : "In AWS_MODE=real the standard AWS credential chain is used. Set AWS_ACCESS_KEY_ID and " +
        "AWS_SECRET_ACCESS_KEY, configure a CLI profile, or run somewhere with an instance or task role.";

    return {
      code: name,
      problem: "No source credentials were found.",
      fix: `${fix}\n\n  What was checked: ${checked.join("; ")}.`,
    };
  }
  return {
    code: name,
    problem: message.slice(0, 200),
    fix: "See the API logs for the full error.",
  };
}
