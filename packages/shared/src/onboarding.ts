/**
 * The connection recipe: one definition of what a customer has to run, because
 * three things need it and must never disagree - the Connection screen that
 * renders the command, `npm run setup` that executes it, and the API that
 * diagnoses what the reader ended up with.
 *
 * It lived in the React component alone, so a setup script would have been a
 * second drifting copy. Every cross-artefact defect in this project's log is
 * that shape: two places that had to agree, with nothing checking (logs #39,
 * #42, #45, #47).
 *
 * Builds strings only - no AWS, no configuration - so it is cheap to test and
 * safe in a browser bundle.
 */

/** The CloudFormation stack the customer deploys. */
export const STACK_NAME = "sightline-readonly";

/**
 * The role the stack creates, matching `RoleName`'s default in
 * `cloudformation/readonly-role.yaml`. A test asserts the two agree, because a drift here
 * means the reader configures a role that does not exist and the connection test
 * reports `NoSuchEntity`.
 */
export const READ_ONLY_ROLE_NAME = "SightlineReadOnlyRole";

/**
 * The deployment with one tenant, which has nothing to collide with.
 *
 * Per-tenant names exist because an AWS account holds one role of a given name,
 * with one trust policy and therefore one ExternalId - so two tenants naming
 * the same role could not both connect the same account: the last to deploy
 * owned it and the other was refused for ever. A limitation rather than a leak
 * only because the loser cannot connect at all.
 *
 * A clone keeps the original names: there is nothing to disambiguate, and
 * renaming would orphan the role every existing install deployed, including the
 * one `--disconnect` deletes by name. Passed explicitly rather than omitted, so
 * a forgotten tenant id is a compile error rather than a silent collision.
 */
export const LEGACY_SINGLE_TENANT = "legacy-single-tenant";

/** How much of a tenant id goes into the names that tenant owns. */
const TENANT_SUFFIX_LENGTH = 12;

/**
 * The part of a tenant id that names resources in a customer's account.
 *
 * Hex from the id itself rather than a hash: it needs no crypto (this module is
 * in the browser bundle), it is the same string every time, and anyone can
 * check by eye which tenant a role belongs to. 48 bits, so a collision needs
 * two tenants agreeing in their first 12 hex digits *and* connecting the same
 * AWS account; the consequence would be today's refusal, not a crossing of
 * tenants.
 *
 * Throws on anything that is not an id, because the alternative is naming a
 * customer's role after a typo.
 */
export function tenantSuffix(tenantId: string): string {
  const hex = tenantId.toLowerCase().replace(/[^0-9a-f]/g, "");
  if (hex.length < TENANT_SUFFIX_LENGTH) {
    throw new Error(
      `"${tenantId}" cannot name a role: a tenant id needs at least ${TENANT_SUFFIX_LENGTH} ` +
        "hexadecimal characters, and this has " +
        `${hex.length}. Pass LEGACY_SINGLE_TENANT for a self-hosted deployment.`,
    );
  }
  return hex.slice(0, TENANT_SUFFIX_LENGTH);
}

/** The role this tenant's stack creates. */
export function readOnlyRoleName(tenantId: string): string {
  return tenantId === LEGACY_SINGLE_TENANT
    ? READ_ONLY_ROLE_NAME
    : `${READ_ONLY_ROLE_NAME}-${tenantSuffix(tenantId)}`;
}

/**
 * The stack this tenant deploys.
 *
 * Suffixed for the same reason as the role: a second stack of the same name in
 * one account fails with `AlreadyExistsException`, which reads as "already
 * connected" to somebody who has never connected it.
 */
export function stackNameFor(tenantId: string): string {
  return tenantId === LEGACY_SINGLE_TENANT ? STACK_NAME : `${STACK_NAME}-${tenantSuffix(tenantId)}`;
}

/** Where the template lives, relative to the repository root. */
export const TEMPLATE_PATH = "cloudformation/readonly-role.yaml";

/**
 * Which published template a customer deployed.
 *
 * Recorded against the connection, because this project has already shipped the
 * failure it prevents: a role deployed from an older copy of the template
 * matched a `sts:SourceIdentity` pattern no legal value could satisfy, and the
 * assume was refused with an `AccessDenied` that mentioned nothing relevant.
 * With the version stored, that becomes something detected rather than
 * something diagnosed an hour later.
 *
 * Bump it whenever a change to the template would break a role deployed from
 * the previous one.
 */
export const TEMPLATE_VERSION = "v1";

/**
 * Prefix for generated ExternalIds, and for the `sts:SourceIdentity` the scanner
 * sends. Hyphen, not colon: AWS rejects a colon in a SourceIdentity, and the
 * trust policy's `StringLike` has to be satisfiable.
 */
export const SIGHTLINE_PREFIX = "sightline-";

/** The placeholder `.env.example` ships for the mock's access key. */
export const MOCK_ACCESS_KEY_PLACEHOLDER = "mock";

/**
 * The ARN of the role the stack creates, given an account id.
 *
 * Used to pre-fill `AWS_TARGET_ROLE_ARN`, and by the setup script to check the
 * value it read back from the stack outputs is the one it expected.
 */
export function readOnlyRoleArn(accountId: string, tenantId: string): string {
  return `arn:aws:iam::${accountId}:role/${readOnlyRoleName(tenantId)}`;
}

/**
 * The one-click CloudFormation link.
 *
 * Opens the console's Create-stack page with every parameter filled in, so the
 * customer ticks the IAM acknowledgement and presses the button. That checkbox
 * is the only thing that cannot be pre-set, and it is there because the stack
 * creates a named IAM role.
 *
 * Parameters go in the URL **fragment**, where the console's own router reads
 * them - the real query string does nothing - and each value is encoded
 * individually, because `URLSearchParams` encodes `/` and `:` into a form the
 * console does not unpick.
 *
 * `region` is where the *stack* is created; the role itself is global.
 */
export interface QuickCreateInput {
  /** The published template, as an https URL the CloudFormation console can fetch. */
  templateUrl: string;
  /** The principal allowed to assume the new role: this service's own identity. */
  scannerPrincipalArn: string;
  externalId: string;
  region: string;
  /** Whose connection this is, which names the role and the stack. */
  tenantId: string;
}

export function quickCreateUrl(input: QuickCreateInput): string {
  const params = [
    ["templateURL", input.templateUrl],
    ["stackName", stackNameFor(input.tenantId)],
    ["param_SightlineScannerRoleArn", input.scannerPrincipalArn],
    ["param_ExternalId", input.externalId],
    // Pre-filled, so the customer never types it. The template's `RoleName`
    // has a default and no pattern, so this needs no change to the template -
    // which means no new published version and no stack already deployed from
    // the old one breaking.
    ["param_RoleName", readOnlyRoleName(input.tenantId)],
  ]
    .map(([key, value]) => `${key}=${encodeURIComponent(value!)}`)
    .join("&");

  return (
    `https://${input.region}.console.aws.amazon.com/cloudformation/home` +
    `?region=${encodeURIComponent(input.region)}` +
    `#/stacks/create/review?${params}`
  );
}

/**
 * The same stack as Terraform, for an estate that is managed that way.
 *
 * Offered because a quick-create link is useless to anyone whose organisation
 * forbids creating stacks from the console, and telling them to do it anyway is
 * how onboarding stops at the first screen. Derived from the same constants as
 * the link and the CLI command, so the three cannot describe different roles.
 */
export function terraformSnippet(input: {
  templateUrl: string;
  scannerPrincipalArn: string;
  externalId: string;
  /** Whose connection this is, which names the role and the stack. */
  tenantId: string;
}): string {
  const stack = stackNameFor(input.tenantId);
  const label = stack.replace(/-/g, "_");
  return `# Sightline read-only access (${TEMPLATE_VERSION}).
# Equivalent to the CloudFormation stack; see ${TEMPLATE_PATH} for the full
# permission set and the reasoning behind it.
resource "aws_cloudformation_stack" "${label}" {
  name         = "${stack}"
  capabilities = ["CAPABILITY_NAMED_IAM"]
  template_url = "${input.templateUrl}"

  parameters = {
    SightlineScannerRoleArn = "${input.scannerPrincipalArn}"
    ExternalId              = "${input.externalId}"
    RoleName                = "${readOnlyRoleName(input.tenantId)}"
  }
}

output "sightline_role_arn" {
  value = aws_cloudformation_stack.${label}.outputs["RoleArn"]
}`;
}

export interface DeployCommandInput {
  /** The principal permitted to assume the new role: an `iam` ARN, not `sts`. */
  scannerPrincipalArn: string;
  externalId: string;
  /** Where the stack is created. The role itself is global. */
  region: string;
  /** Optional named profile, when the default one is not the target account. */
  profile?: string | undefined;
  /** Whose connection this is, which names the role and the stack. */
  tenantId: string;
}

/**
 * The deploy command, as an argument vector.
 *
 * A vector rather than a string because the setup script must **execute** this
 * without a shell: passing a composed command line to a shell is how an account
 * id containing a quote becomes an injection. The display form is derived from
 * the same vector by `formatDeployCommand`, so the command a reader copies and
 * the command the script runs cannot differ.
 */
export function deployCommandArgs(input: DeployCommandInput): string[] {
  const args = [
    "cloudformation",
    "deploy",
    "--template-file",
    TEMPLATE_PATH,
    "--stack-name",
    stackNameFor(input.tenantId),
    // Without an explicit region this fails outright on a CLI that has no
    // default configured, with an error that mentions nothing in this project.
    "--region",
    input.region,
    "--capabilities",
    "CAPABILITY_NAMED_IAM",
    "--parameter-overrides",
    `SightlineScannerRoleArn=${input.scannerPrincipalArn}`,
    `ExternalId=${input.externalId}`,
    `RoleName=${readOnlyRoleName(input.tenantId)}`,
  ];
  if (input.profile) args.push("--profile", input.profile);
  return args;
}

/**
 * The same command, formatted for a human to read and paste.
 *
 * Line continuations and indentation only. Derived from `deployCommandArgs` so
 * the two cannot drift; `--parameter-overrides` keeps its values on their own
 * lines because that is where readers make substitutions.
 */
export function formatDeployCommand(input: DeployCommandInput): string {
  const args = deployCommandArgs(input);

  // The leading subcommand words belong on the first line: `aws cloudformation
  // deploy \`, which is the shape every AWS example uses and what readers of
  // this project have already seen.
  let i = 0;
  const subcommand: string[] = ["aws"];
  while (i < args.length && !args[i]!.startsWith("--")) subcommand.push(args[i++]!);
  const lines: string[] = [`${subcommand.join(" ")} \\`];

  for (; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--parameter-overrides") {
      lines.push("  --parameter-overrides \\");
      // Everything after this is a Key=Value override, except a trailing
      // --profile pair. Overrides are indented further because they are what a
      // reader substitutes into.
      for (let j = i + 1; j < args.length; j++) {
        const next = args[j]!;
        if (next === "--profile") {
          lines.push(`  --profile ${args[j + 1]} \\`);
          j++;
          continue;
        }
        lines.push(`      ${next} \\`);
      }
      break;
    }
    if (arg.startsWith("--")) {
      lines.push(`  ${arg} ${args[i + 1]} \\`);
      i++;
      continue;
    }
    lines.push(`  ${arg} \\`);
  }

  // The last line must not continue, or a paste hangs waiting for more input.
  const last = lines.length - 1;
  lines[last] = lines[last]!.replace(/ \\$/, "");
  return lines.join("\n");
}

/**
 * The `.env` keys that describe a connection, and nothing else.
 *
 * The setup script rewrites exactly these and leaves every other line of a
 * user's `.env` untouched. Enumerating them is what makes that promise
 * checkable rather than a claim about a regex.
 */
export const CONNECTION_ENV_KEYS = [
  "AWS_MODE",
  "AWS_TARGET_ROLE_ARN",
  "AWS_EXTERNAL_ID",
  "AWS_REGION",
  "AWS_SCAN_REGIONS",
] as const;

/** Keys the script may write that are not part of a connection. */
export const OTHER_MANAGED_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "COMPOSE_FILE",
  "COMPOSE_PATH_SEPARATOR",
] as const;

/**
 * The same role in every account of an AWS Organization: a service-managed
 * StackSet, run from the management account, deploying to the root so new
 * accounts get it automatically. Service-managed StackSets skip the management
 * account itself, which gets the ordinary stack - the one-click link.
 *
 * One ExternalId for every member: it is the organization connection's, which
 * each member connection inherits. IAM is global, so one region is enough.
 */
export function stackSetCommands(input: {
  templateUrl: string;
  scannerPrincipalArn: string;
  externalId: string;
  region: string;
  tenantId: string;
}): string {
  const name = stackNameFor(input.tenantId);
  const param = (key: string, value: string) => `ParameterKey=${key},ParameterValue=${value}`;
  const more = " \\";
  return [
    "aws cloudformation create-stack-set" + more,
    `  --stack-set-name ${name}` + more,
    `  --template-url ${input.templateUrl}` + more,
    "  --capabilities CAPABILITY_NAMED_IAM" + more,
    "  --permission-model SERVICE_MANAGED" + more,
    "  --auto-deployment Enabled=true,RetainStacksOnAccountRemoval=false" + more,
    "  --parameters" + more,
    `      ${param("SightlineScannerRoleArn", input.scannerPrincipalArn)}` + more,
    `      ${param("ExternalId", input.externalId)}` + more,
    `      ${param("RoleName", readOnlyRoleName(input.tenantId))}`,
    "",
    "# Your organization's root id: aws organizations list-roots --query 'Roots[0].Id'",
    "aws cloudformation create-stack-instances" + more,
    `  --stack-set-name ${name}` + more,
    "  --deployment-targets OrganizationalUnitIds=<root id, r-xxxx>" + more,
    `  --regions ${input.region}`,
  ].join("\n");
}
