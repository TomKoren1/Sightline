/**
 * Onboarding guide for connecting a real AWS account.
 *
 * This screen **guides** onboarding rather than performing it, and the
 * distinction is deliberate rather than a shortcut.
 *
 * The obvious feature is a form: paste a role ARN and an external id, press
 * connect. This API has no authentication, so that form would be an open
 * endpoint that assumes a role into somebody's AWS account and persists a value
 * the role template itself calls a credential. Building it would make the demo
 * look more complete and the product less defensible.
 *
 * So the server generates what a customer needs, renders the exact command, and
 * tests the connection that is already configured. Putting the role ARN into
 * configuration stays a deliberate act by an operator with host access. The
 * reasoning is shown to the user too, in step 4 — a customer granting a third
 * party standing access into their account deserves to see how that access is
 * constrained.
 *
 * **Every command block declares which values are pre-filled and which the
 * reader has to supply**, via `<Fields>`. Handing someone a command to paste
 * without saying which parts are theirs is how they end up deploying a role
 * into the wrong account, and the failure surfaces much later as an
 * `AccessDenied` that looks like a bug in this product.
 */

import { useMutation, useQuery } from "@tanstack/react-query";

import { api, type Connection, type ConnectionTest } from "../api.js";
import { Copyable } from "./Copyable.js";

/**
 * Stand-in used while the generated ExternalId is still in flight.
 *
 * Never a human-readable status word. This previously interpolated
 * `"generating…"` directly into both command blocks, so a reader who copied
 * fast enough deployed a stack whose ExternalId was literally `generating…`
 * and put the same string in `.env` - a connection that tests green against
 * the wrong secret. A token shaped like this cannot be mistaken for a value.
 */
const EXTERNAL_ID_PENDING = "PASTE_EXTERNAL_ID_FROM_STEP_2";

/** The one value in step 4 the reader must replace, shaped like a real ARN. */
const ROLE_ARN_TEMPLATE = "arn:aws:iam::<your-12-digit-account-id>:role/DaveIoReadOnlyRole";

function Step({
  n,
  title,
  children,
  done,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
  done?: boolean;
}) {
  return (
    <section className="flex gap-3">
      <div
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold ${
          done ? "border-good/50 bg-good/15 text-good" : "border-ink-600 bg-ink-800 text-ink-300"
        }`}
      >
        {done ? "✓" : n}
      </div>
      <div className="min-w-0 flex-1 space-y-1.5 pb-1">
        <h3 className="text-[12px] font-semibold text-ink-100">{title}</h3>
        {children}
      </div>
    </section>
  );
}

/**
 * Which parts of the command above are already correct, and which are yours.
 *
 * `replace` is styled loudest on purpose: in both blocks on this page it is
 * the minority case, and a reader who skims will otherwise assume - correctly
 * for every other line - that the value is filled in.
 */
function Fields({
  rows,
}: {
  rows: { name: string; kind: "filled" | "replace" | "optional"; note: string }[];
}) {
  const tag = {
    filled: { text: "filled in", cls: "border-good/40 bg-good/10 text-good" },
    replace: { text: "you replace", cls: "border-warn/50 bg-warn/15 text-warn" },
    optional: { text: "optional", cls: "border-ink-600 bg-ink-800 text-ink-400" },
  };
  return (
    <ul className="space-y-1">
      {rows.map((r) => (
        <li key={r.name} className="flex items-baseline gap-1.5 text-[10px] leading-relaxed">
          <span
            className={`mt-px shrink-0 rounded border px-1 py-px text-[9px] font-medium ${tag[r.kind].cls}`}
          >
            {tag[r.kind].text}
          </span>
          <span className="min-w-0">
            <code className="break-all text-ink-300">{r.name}</code>{" "}
            <span className="text-ink-400">— {r.note}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function ConnectionGuide() {
  const connection = useQuery({ queryKey: ["connection"], queryFn: api.connection });
  const externalId = useQuery({
    queryKey: ["externalId"],
    queryFn: api.newExternalId,
    // Generated on demand, never stored, and not refetched on every render -
    // a value that changes while the user is copying it is worse than useless.
    staleTime: Infinity,
    gcTime: Infinity,
  });
  const test = useMutation<ConnectionTest, Error>({ mutationFn: api.testConnection });

  if (connection.isLoading) return <div className="h-40 animate-pulse rounded bg-ink-850" />;
  if (!connection.data)
    return <p className="text-[12px] text-danger">Could not read the current connection.</p>;

  const c: Connection = connection.data;
  const isReal = c.mode === "real";

  /**
   * Whether the generated id is actually here. Kept separate from its value so
   * a pending or failed fetch degrades to a loud token rather than to prose
   * that reads like a value (see EXTERNAL_ID_PENDING).
   */
  const externalIdReady = typeof externalId.data?.externalId === "string";
  const suggestedId = externalId.data?.externalId ?? EXTERNAL_ID_PENDING;

  /**
   * The principal to trust, already converted from the session ARN.
   *
   * This used to print `c.callerIdentity` directly, which is what
   * `GetCallerIdentity` returns: an `arn:aws:sts::...` **session** ARN. A trust
   * policy needs the `arn:aws:iam::...` **identity** behind it. Pasting the
   * former fails the template's AllowedPattern, and against the mock it emits
   * `arn:aws:sts::123456789012:user/moto` - moto's identity, offered as the
   * principal to trust in somebody's real account. The conversion happens on
   * the server (aws/principal.ts); see engineering log #28.
   */
  /**
   * Every unknown part is marked, not just the account id.
   *
   * This was `arn:aws:iam::<account>:role/DaveIoScanner`, which has one marked
   * blank and *two* unknowns: the role name is equally invented. A reader fills
   * in the account they know, leaves the rest because it looks real, and deploys
   * a trust policy naming a principal that does not exist - CloudFormation
   * rejects it with "Invalid principal in policy", which says nothing about
   * which half was wrong. That happened (engineering log #46).
   */
  const scannerPrincipal =
    c.scannerPrincipal ?? "arn:aws:iam::<account-id>:<role-or-user>/<name-of-this-identity>";
  const principalUnresolved = c.scannerPrincipal === null;

  /** Proves which account and identity the next command will actually act as. */
  const whoamiCommand = "aws sts get-caller-identity";

  const deployCommand = [
    "aws cloudformation deploy \\",
    "  --template-file infra/readonly-role.yaml \\",
    "  --stack-name daveio-readonly \\",
    // Without an explicit region this fails outright on a CLI that has no
    // default configured, with an error that says nothing about this page.
    `  --region ${c.homeRegion} \\`,
    "  --capabilities CAPABILITY_NAMED_IAM \\",
    "  --parameter-overrides \\",
    `      DaveIoScannerRoleArn=${scannerPrincipal} \\`,
    `      ExternalId=${suggestedId}`,
  ].join("\n");

  const envSnippet = [
    "AWS_MODE=real",
    `AWS_TARGET_ROLE_ARN=${ROLE_ARN_TEMPLATE}`,
    `AWS_EXTERNAL_ID=${suggestedId}`,
    "AWS_SCAN_REGIONS=",
  ].join("\n");

  return (
    <div className="space-y-4">
      {/* ---- Where things stand right now ------------------------------- */}
      <div
        className={`rounded border px-2.5 py-2 ${
          isReal ? "border-accent/40 bg-accent/10" : "border-ink-700 bg-ink-850"
        }`}
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[12px] font-semibold text-ink-100">
            {isReal ? "Connected to a real AWS account" : "Running against the mock AWS account"}
          </span>
          <span className="shrink-0 font-mono text-[10px] text-ink-400">{c.mode}</span>
        </div>
        <dl className="mt-1 space-y-0.5 text-[10px]">
          <Row label="Role" value={c.roleArn} mono />
          {/* Labelled "Target account" because it is the account that would be
              scanned, derived from the role ARN - not the account this backend
              runs in, which is the other identity in play throughout. */}
          <Row label="Target account" value={c.accountId ?? "unknown"} mono />
          <Row
            label="ExternalId"
            value={
              c.externalIdIsPlaceholder
                ? `${c.externalIdMasked} — still a placeholder`
                : c.externalIdMasked
            }
            mono
            tone={c.externalIdIsPlaceholder ? "text-warn" : undefined}
          />
          {c.endpointOverride && <Row label="Endpoint" value={c.endpointOverride} mono />}
          <Row label="Regions" value={c.regions?.join(", ") ?? "discovered from AWS"} />
        </dl>
      </div>

      {c.roleArnProblem && (
        <div className="rounded border border-danger/50 bg-danger/10 px-2.5 py-2">
          <p className="text-[11px] font-semibold text-danger">
            AWS_TARGET_ROLE_ARN cannot be assumed
          </p>
          <p className="mt-0.5 whitespace-pre-line text-[10px] leading-relaxed text-ink-300">
            {c.roleArnProblem}
          </p>
        </div>
      )}

      <p className="text-[12px] leading-relaxed text-ink-300">
        Connecting a real account takes five steps and about five minutes. dave.io never receives
        your AWS keys — it assumes a role that you create, in your account, which you can inspect
        before deploying and delete at any time.
      </p>

      {/* ---- What the reader has to bring, and the identity confusion ---- */}
      <div className="space-y-2 rounded border border-ink-700 bg-ink-850 px-2.5 py-2">
        <p className="text-[11px] font-semibold text-ink-100">Before you start</p>
        <p className="text-[10px] leading-relaxed text-ink-400">
          You need two things: the <strong className="text-ink-300">12-digit id</strong> of the AWS
          account you want scanned, and AWS CLI credentials{" "}
          <strong className="text-ink-300">in that account</strong> allowed to create an IAM role (
          <code>cloudformation:*</code> on the stack, plus <code>iam:CreateRole</code> and{" "}
          <code>iam:PutRolePolicy</code>). Confirm both before running anything:
        </p>
        <Copyable value={whoamiCommand} label="confirm which account you are about to change" />
        <div className="rounded border border-ink-700 bg-ink-950 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-ink-400">
          {"{"}
          <br />
          {'  "Account": "111122223333",'}{" "}
          <span className="text-ink-500">← the stack is created here</span>
          <br />
          {'  "Arn": "arn:aws:iam::111122223333:user/you"'}{" "}
          <span className="text-ink-500">← as this identity</span>
          <br />
          {"}"}
        </div>
        <p className="text-[10px] leading-relaxed text-ink-400">
          If <code>Account</code> is not the account you meant, switch profile and re-run —{" "}
          <code>export AWS_PROFILE=name</code>, or add <code>--profile name</code> to the command in
          step 3. Getting this wrong creates the role in the wrong account, and the mistake only
          surfaces in step 5 as a confusing <code>NoSuchEntity</code>.
        </p>

        {/*
          The page already explained the two *roles*. The two *identities* are a
          separate and more common confusion, and nothing said so.
        */}
        <div className="border-t border-ink-700 pt-1.5">
          <p className="text-[10px] font-semibold text-ink-300">
            Two identities are involved. They are not the same thing.
          </p>
          <ul className="mt-1 space-y-1 text-[10px] leading-relaxed text-ink-400">
            <li>
              <strong className="text-ink-300">Yours</strong>, above — an admin in the target
              account. Used once, to create the role. dave.io never sees it and it is not stored
              anywhere.
            </li>
            <li>
              <strong className="text-ink-300">This backend&apos;s</strong> —{" "}
              <code className="break-all">{scannerPrincipal}</code>. Named in the new role&apos;s
              trust policy so it can assume the role later. This is the value already filled into
              step 3, and it is <em>not</em> something you replace.
            </li>
          </ul>
        </div>
      </div>

      <div className="space-y-3.5 border-t border-ink-800 pt-3.5">
        <Step n={1} title="Review what access you are granting">
          <p className="text-[11px] leading-relaxed text-ink-400">
            The role grants <strong className="text-ink-300">SecurityAudit</strong> and{" "}
            <strong className="text-ink-300">ViewOnlyAccess</strong> — enough to list resources and
            read their configuration — plus an explicit{" "}
            <strong className="text-ink-300">Deny</strong> on reading your actual data: no{" "}
            <code>s3:GetObject</code>, <code>secretsmanager:GetSecretValue</code>,{" "}
            <code>dynamodb:GetItem</code>, <code>ssm:GetParameter</code>, or{" "}
            <code>sqs:ReceiveMessage</code>.
          </p>
          <p className="text-[11px] leading-relaxed text-ink-400">
            A Deny in IAM cannot be overridden by any Allow, so this holds even if a future AWS
            update widens one of those managed policies. It is also why the commonly-used{" "}
            <code>ReadOnlyAccess</code> policy is deliberately not used here: it permits reading
            object and secret contents, which an inventory tool never needs.
          </p>
          <p className="text-[11px] text-ink-400">
            The template is <code className="text-ink-300">infra/readonly-role.yaml</code> — read it
            before deploying.
          </p>
        </Step>

        <Step n={2} title="Take your ExternalId">
          <p className="text-[11px] leading-relaxed text-ink-400">
            A secret unique to you. The role&apos;s trust policy requires it, so knowing the
            role&apos;s ARN is not enough to assume it — this is what prevents a third party from
            tricking dave.io into using its access against your account.
          </p>
          <Copyable value={suggestedId} />
          {externalIdReady ? (
            <p className="text-[10px] text-ink-400">
              Generated for you and <strong>not stored anywhere</strong>. Treat it like a password:
              the same value goes into the stack in step 3 and into configuration in step 4, and
              they must match byte for byte.
            </p>
          ) : (
            <p className="rounded border border-warn/40 bg-warn/10 px-2 py-1.5 text-[10px] leading-relaxed text-warn">
              {externalId.isError
                ? "Could not generate an ExternalId. Use any long random string of your own — it only has to be identical in step 3 and step 4."
                : "Still generating. The commands below carry a placeholder until it arrives; wait for it rather than pasting them now."}
            </p>
          )}
        </Step>

        <Step n={3} title="Create the role in your account">
          <p className="text-[11px] leading-relaxed text-ink-400">
            Run this against the account you confirmed above. It creates one IAM role and nothing
            else.
          </p>
          <Copyable value={deployCommand} />
          <Fields
            rows={[
              /**
               * "filled in" only when it really is. Unresolved, this said
               * "filled in — the identity this backend runs as" above a
               * placeholder, which is the legend actively lying in the one place
               * a reader trusts it to be right.
               */
              principalUnresolved
                ? {
                    name: "DaveIoScannerRoleArn",
                    kind: "replace" as const,
                    note: "NOT filled in — this backend could not work out its own identity. Run `aws sts get-caller-identity` and use the Arn it reports, converting assumed-role/Foo/session to role/Foo. Every angle-bracketed part above is a placeholder, the role name included.",
                  }
                : {
                    name: "DaveIoScannerRoleArn",
                    kind: "filled" as const,
                    note: "the identity this backend runs as, converted to a form a trust policy accepts",
                  },
              { name: "ExternalId", kind: "filled", note: "the value from step 2" },
              {
                name: "--region",
                kind: "filled",
                note: `${c.homeRegion}, from AWS_REGION. The role itself is global; this is where the stack lives.`,
              },
              {
                name: "--profile",
                kind: "optional",
                note: "add it if your default profile is not the target account",
              },
            ]}
          />
          {principalUnresolved && (
            <p className="rounded border border-warn/40 bg-warn/10 px-2 py-1.5 text-[10px] leading-relaxed text-warn">
              <strong>Do not run the command above as it stands.</strong>{" "}
              {c.scannerPrincipalNote ?? "This backend could not determine its own identity."} Every
              angle-bracketed part of that ARN is a placeholder — the <code>role/</code> name as
              much as the account id. Deployed as-is it names a principal that does not exist, and
              CloudFormation fails with <code>Invalid principal in policy</code> without saying
              which part was wrong. Run <code>aws sts get-caller-identity</code> and use the{" "}
              <code>Arn</code> it reports.
            </p>
          )}
          {!principalUnresolved && c.callerIdentityIsMock && (
            <p className="rounded border border-warn/40 bg-warn/10 px-2 py-1.5 text-[10px] leading-relaxed text-warn">
              You are on the demo account, so the principal above is the mock&apos;s own identity,
              not yours. Fine for reading through these steps; before deploying for real, switch to{" "}
              <strong>My AWS</strong> or run <code>aws sts get-caller-identity</code> yourself and
              use that identity instead.
            </p>
          )}
          <div className="rounded border border-ink-700 bg-ink-850 px-2 py-1.5">
            <p className="text-[10px] leading-relaxed text-ink-400">
              <strong className="text-ink-300">
                Two roles are involved, and confusing them is the usual mistake.
              </strong>{" "}
              <code>DaveIoScannerRoleArn</code> is an <em>input</em> — the principal permitted to
              assume the new role, already filled in above with the identity this backend runs as.
              The stack then <em>creates</em> a different role, <code>DaveIoReadOnlyRole</code>, and
              its <code>RoleArn</code> output is what step 4 wants.
            </p>
            {c.scannerPrincipalConverted && c.callerIdentity && (
              <p className="mt-1 text-[10px] leading-relaxed text-ink-400">
                <strong className="text-ink-300">Note the ARN was converted.</strong>{" "}
                <code>get-caller-identity</code> reports the <em>session</em> you are using, so it
                returns <code className="break-all">{c.callerIdentity}</code> — an <code>sts</code>{" "}
                ARN. A trust policy needs the <code>iam</code> identity behind that session, which
                is what the command uses. Pasting the <code>sts</code> form fails the
                template&apos;s own parameter pattern.
              </p>
            )}
            <p className="mt-1 text-[10px] leading-relaxed text-ink-400">
              Pointing <code>AWS_TARGET_ROLE_ARN</code> at the scanner principal instead of the
              created role gives <code>AccessDenied</code>, or <code>NoSuchEntity</code> if it does
              not exist.
            </p>
          </div>
          <p className="text-[10px] leading-relaxed text-ink-400">
            When it finishes, copy the <code>RoleArn</code> output. In production dave.io would host
            this template at a stable HTTPS URL and hand you a one-click CloudFormation link; the
            CLI form is used here because the template lives in this repository.
          </p>
        </Step>

        <Step n={4} title="Point this deployment at the role">
          <p className="text-[11px] leading-relaxed text-ink-400">
            Add these to <code className="text-ink-300">.env</code> in the repository root.
          </p>
          <Copyable value={envSnippet} />
          <Fields
            rows={[
              {
                name: "AWS_TARGET_ROLE_ARN",
                kind: "replace",
                note: 'the only value here that is yours. Paste the stack\'s RoleArn output whole, or swap <your-12-digit-account-id> for the Account from "Before you start". The role name is already right unless you overrode RoleName.',
              },
              { name: "AWS_MODE", kind: "filled", note: "real, so AWS is called instead of moto" },
              { name: "AWS_EXTERNAL_ID", kind: "filled", note: "same value you deployed with" },
              {
                name: "AWS_SCAN_REGIONS",
                kind: "optional",
                note: "leave empty to discover every enabled region; set a comma-separated list to narrow it",
              },
            ]}
          />
          <p className="text-[10px] leading-relaxed text-warn">
            While you are in there, delete <code>AWS_ENDPOINT_URL</code>,{" "}
            <code>AWS_ACCESS_KEY_ID</code> and <code>AWS_SECRET_ACCESS_KEY</code> if they still hold
            the mock&apos;s values. The AWS SDK reads those from the environment itself, so leaving
            them sends every request to the mock and shadows your real credentials. The API removes
            them and warns on startup, but deleting them is cleaner.
          </p>

          {/*
            One restart instruction, not two and a rule for choosing.

            The server reports whether it is containerised, because the two cases
            differ in a way that silently wastes time: `docker compose restart`
            reuses the environment resolved when the container was created, so it
            exits zero and ignores the edit entirely (engineering log #44).
          */}
          <div className="rounded border border-accent/30 bg-accent/5 px-2 py-1.5">
            {c.containerised ? (
              <>
                <p className="text-[10px] leading-relaxed text-ink-300">
                  <strong>Then recreate the API.</strong> This one is running in a container, so:
                </p>
                <p className="mt-1 break-all font-mono text-[10px] text-accent">
                  docker compose --profile app up -d api
                </p>
                <p className="mt-1 text-[10px] leading-relaxed text-ink-400">
                  Not <code>docker compose restart api</code> — that reuses the environment resolved
                  when the container was created, so it exits successfully and ignores the edit.
                  Configuration is read once at startup, so the process has to be replaced rather
                  than restarted.
                </p>
              </>
            ) : (
              <>
                <p className="text-[10px] leading-relaxed text-ink-300">
                  <strong>Then restart the API</strong> — configuration is read once at startup, so
                  an edit with no restart changes nothing. This one is running on the host, so stop{" "}
                  <code>npm run dev:api</code> and start it again.
                </p>
                <p className="mt-1 text-[10px] leading-relaxed text-ink-400">
                  In the containerised setup it is{" "}
                  <code>docker compose --profile app up -d api</code> instead — recreated, not
                  restarted.
                </p>
              </>
            )}
          </div>

          {/*
            Shown only in a container, where it is the step that actually blocks
            people. On a host the credential chain finds ~/.aws by itself and this
            would be noise.
          */}
          {c.containerised && (
            <div className="rounded border border-warn/40 bg-warn/10 px-2 py-1.5">
              <p className="text-[10px] leading-relaxed text-warn">
                <strong>Your credentials also have to reach the container.</strong> A real account
                uses the standard AWS credential chain, which on your machine finds{" "}
                <code>~/.aws</code>. A container has no such directory unless it is given one, so a
                profile that works on the host fails in here with{" "}
                <em>&ldquo;No source credentials were found&rdquo;</em>. Uncomment this in{" "}
                <code>.env</code> and bring the stack up again:
              </p>
              <p className="mt-1 break-all font-mono text-[10px] text-warn">
                COMPOSE_FILE=docker-compose.yml:deploy/compose.aws-profile.yml
              </p>
              <p className="mt-1 text-[10px] leading-relaxed text-warn">
                On Windows, also set <code>AWS_PROFILE_DIR</code> to the full path of your{" "}
                <code>.aws</code> folder — PowerShell does not set <code>HOME</code>, and Compose
                treats an unset variable as an empty string with only a warning, so the mount would
                silently contain nothing.
              </p>
              <p className="mt-1 text-[10px] leading-relaxed text-warn">
                It goes in <code>.env</code> rather than as <code>-f</code> flags on purpose: it
                then applies to every <code>docker compose</code> command, so recreating this
                container to pick up an edited <code>.env</code> cannot quietly drop the mount.
              </p>
              <p className="mt-1 text-[10px] leading-relaxed text-warn">
                Real keys in <code>AWS_ACCESS_KEY_ID</code> and <code>AWS_SECRET_ACCESS_KEY</code>{" "}
                work too, but the mount is better: it keeps long-lived credentials out of a file
                next to the code, and it carries the SSO token cache, so <code>aws sso login</code>{" "}
                on the host works in here as well.
              </p>
            </div>
          )}

          <div className="rounded border border-ink-700 bg-ink-850 px-2 py-1.5">
            <p className="text-[10px] leading-relaxed text-ink-400">
              <strong className="text-ink-300">Why there is no form here.</strong> This API has no
              authentication. A page that accepted a role ARN and an ExternalId would be an open
              endpoint that assumes a role into an AWS account and stores a credential — so
              configuring the connection stays a deliberate act by someone with access to the host.
              A multi-tenant version would put authentication, per-tenant isolation and encrypted
              secret storage in place first, and only then offer the form.
            </p>
          </div>
        </Step>

        <Step n={5} title="Verify it works" done={test.data?.ok === true}>
          <p className="text-[11px] leading-relaxed text-ink-400">
            Assumes the role and calls <code>GetCallerIdentity</code> — two read-only calls that
            prove the trust policy works without touching anything.
          </p>
          <button
            onClick={() => test.mutate()}
            disabled={test.isPending}
            className="rounded bg-accent px-2.5 py-1 text-[11px] font-medium text-ink-950 transition hover:brightness-110 disabled:opacity-40"
          >
            {test.isPending ? "Testing…" : "Test connection"}
          </button>

          {test.data?.ok && (
            <div className="rounded border border-good/40 bg-good/10 px-2.5 py-1.5 text-[11px] text-good">
              <strong>Connection works.</strong>
              <div className="mt-0.5 space-y-0.5 font-mono text-[10px] opacity-85">
                <div>assumed: {test.data.assumedRoleArn}</div>
                <div>account: {test.data.accountId}</div>
                <div>endpoint: {test.data.endpoint}</div>
                <div>
                  session expires: {new Date(test.data.expiresAt ?? "").toLocaleTimeString()}{" "}
                  (renewed automatically)
                </div>
              </div>
            </div>
          )}

          {test.data && !test.data.ok && (
            <div className="rounded border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-[11px] text-danger">
              <strong>{test.data.problem}</strong>
              <p className="mt-1 leading-relaxed opacity-90">{test.data.fix}</p>
              {test.data.code && (
                <p className="mt-1 font-mono text-[10px] opacity-70">{test.data.code}</p>
              )}
            </div>
          )}

          {test.isError && <p className="text-[11px] text-danger">{test.error.message}</p>}
        </Step>
      </div>

      <p className="border-t border-ink-800 pt-3 text-[11px] leading-relaxed text-ink-400">
        To revoke access at any time, delete the CloudFormation stack. dave.io holds no credentials
        of yours, so removing the role removes all access immediately.
      </p>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
  tone,
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: string;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="w-20 shrink-0 text-ink-400">{label}</dt>
      <dd className={`min-w-0 break-all ${mono ? "font-mono" : ""} ${tone ?? "text-ink-300"}`}>
        {value}
      </dd>
    </div>
  );
}
