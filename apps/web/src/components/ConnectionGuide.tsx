/**
 * Onboarding guide for connecting a real AWS account. Five steps, one action
 * each, reasoning behind `<Why>` disclosures - the page was 613 lines when each
 * argument sat inline above the command the reader came for.
 *
 * It **guides** onboarding rather than performing it. The obvious feature is a
 * form, but this API has no authentication, so that form would be an open
 * endpoint that assumes a role into somebody's account.
 *
 * `<Fields>` declares which values are pre-filled and which are the reader's. A
 * value that is not known is never labelled as filled in - the defect that sent
 * a real deploy at a principal that did not exist (engineering log #46).
 */

import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { formatDeployCommand, readOnlyRoleArn } from "@sightline/shared";

import { api, type Connection, type ConnectionTest } from "../api.js";
import { Copyable } from "./Copyable.js";

/**
 * Stand-in used while the generated ExternalId is still in flight.
 *
 * Never a human-readable status word. This previously interpolated
 * `"generating…"` directly into both command blocks, so a reader who copied fast
 * enough deployed a stack whose ExternalId was literally `generating…` and put
 * the same string in `.env` — a connection that tests green against a secret
 * neither side meant. A token shaped like this cannot be mistaken for a value.
 */
const EXTERNAL_ID_PENDING = "PASTE_EXTERNAL_ID_FROM_STEP_2";

/** The one value in step 3 the reader must replace, shaped like a real ARN. */
const ROLE_ARN_TEMPLATE = readOnlyRoleArn("<your-12-digit-account-id>");

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
 * Optional depth.
 *
 * A native `<details>` rather than state, so it is keyboard-accessible and
 * findable by the browser's own in-page search even while collapsed — which
 * matters when the answer someone needs is inside one.
 */
function Why({ children, label = "Why this way" }: { children: React.ReactNode; label?: string }) {
  return (
    <details className="group">
      <summary className="cursor-pointer text-[10px] text-ink-500 transition hover:text-ink-300">
        {label}
      </summary>
      <div className="mt-1 space-y-1 border-l border-ink-800 pl-2 text-[10px] leading-relaxed text-ink-400">
        {children}
      </div>
    </details>
  );
}

/** Which parts of the command above are already correct, and which are yours. */
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

/**
 * The two `.env` lines that give a containerised API the host's ~/.aws.
 *
 * Part of the step 3 snippet rather than a note of their own. They used to sit
 * in a warning box under step 4's restart command - read after the restart it
 * needed to precede - and carried only `COMPOSE_FILE`, which Windows Compose
 * splits on `;` and so reads as one missing filename without the separator line
 * (engineering log #45). On a host the chain finds ~/.aws by itself, so these
 * are shown only in a container.
 */
const CONTAINER_PROFILE_MOUNT = [
  "COMPOSE_PATH_SEPARATOR=:",
  "COMPOSE_FILE=docker-compose.yml:deploy/compose.aws-profile.yml",
];

export function ConnectionGuide() {
  const connection = useQuery({ queryKey: ["connection"], queryFn: api.connection });
  const externalId = useQuery({
    queryKey: ["externalId"],
    queryFn: api.newExternalId,
    // A value that changes while the user is copying it is worse than useless.
    staleTime: Infinity,
    gcTime: Infinity,
  });
  const test = useMutation<ConnectionTest, Error>({ mutationFn: api.testConnection });
  const [showAccess, setShowAccess] = useState(false);

  if (connection.isLoading) return <div className="h-40 animate-pulse rounded bg-ink-850" />;
  if (!connection.data)
    return <p className="text-[12px] text-danger">Could not read the current connection.</p>;

  const c: Connection = connection.data;
  const isReal = c.mode === "real";
  const externalIdReady = typeof externalId.data?.externalId === "string";
  const suggestedId = externalId.data?.externalId ?? EXTERNAL_ID_PENDING;

  /**
   * The principal to trust, converted from the session ARN on the server.
   *
   * Every unknown segment of the fallback is marked. It was
   * `arn:aws:iam::<account>:role/SightlineScanner`, which marks one blank and hides
   * two — a reader substitutes the account id and leaves a role name that does
   * not exist, and CloudFormation answers `Invalid principal in policy` without
   * saying which half was wrong (engineering log #46).
   */
  const scannerPrincipal =
    c.scannerPrincipal ?? "arn:aws:iam::<account-id>:<role-or-user>/<name-of-this-identity>";
  const principalUnresolved = c.scannerPrincipal === null;

  /**
   * Built from the shared recipe, not composed here.
   *
   * `npm run setup` executes the same definition, so the command a reader copies
   * and the command the script runs cannot drift - which is the defect class this
   * project's log keeps returning to (#39, #42, #45, #47).
   */
  const deployCommand = formatDeployCommand({
    scannerPrincipalArn: scannerPrincipal,
    externalId: suggestedId,
    region: c.homeRegion,
  });

  const envSnippet = [
    "AWS_MODE=real",
    `AWS_TARGET_ROLE_ARN=${ROLE_ARN_TEMPLATE}`,
    `AWS_EXTERNAL_ID=${suggestedId}`,
    "AWS_SCAN_REGIONS=",
    ...(c.containerised ? CONTAINER_PROFILE_MOUNT : []),
  ].join("\n");

  const restartCommand = c.containerised
    ? "docker compose --profile app up -d api"
    : "restart npm run dev:api";

  return (
    <div className="space-y-4">
      {/* ---- Where things stand ----------------------------------------- */}
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

      {/* ---- the short way --------------------------------------------- */}
      <div className="rounded border border-accent/40 bg-accent/10 px-2.5 py-2">
        <p className="text-[12px] font-semibold text-ink-100">Run this and it does all of it</p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-ink-300">
          It finds the identity to trust, creates the role, reads the ARN back out of the stack,
          writes <code>.env</code> and restarts this API — then tells you whether it worked.
        </p>
        <div className="mt-1.5">
          <Copyable value="npm run setup" />
        </div>
        <p className="mt-1 text-[10px] leading-relaxed text-ink-400">
          Needs the AWS CLI with working credentials. It shows what it will do and asks before
          changing anything, backs up <code>.env</code> first, and touches only the keys it names.{" "}
          <code>npm run setup -- --dry-run</code> prints the plan and changes nothing;{" "}
          <code>--disconnect</code> deletes the role again.
        </p>
      </div>

      {/* ---- the long way, for anyone who would rather see every step --- */}
      <details className="group border-t border-ink-800 pt-3">
        <summary className="cursor-pointer text-[11px] text-ink-400 transition hover:text-ink-200">
          ▸ Or do it by hand — five steps, about five minutes
        </summary>
        <p className="mt-2 text-[12px] leading-relaxed text-ink-300">
          Connecting a real account takes five steps and about five minutes. Sightline never
          receives your AWS keys — it assumes a role you create, in your account, which you can
          delete at any time.
        </p>

        <div className="mt-3 space-y-3.5">
          {/* ---- 1. the identity ------------------------------------------ */}
          <Step n={1} title="An AWS identity that can create the role">
            <p className="text-[11px] leading-relaxed text-ink-400">
              You need AWS CLI credentials in the account you want scanned, allowed to create an IAM
              role. The quickest route is an IAM user with these two AWS-managed policies attached:
            </p>
            <Copyable
              value={"IAMFullAccess\nAWSCloudFormationFullAccess"}
              label="attach to the user"
            />
            <p className="text-[11px] leading-relaxed text-ink-400">
              Then put its access key in <code className="text-ink-300">.env</code> as{" "}
              <code>AWS_ACCESS_KEY_ID</code> and <code>AWS_SECRET_ACCESS_KEY</code>, or configure it
              as a CLI profile. Confirm which account and identity you are about to use:
            </p>
            <Copyable value="aws sts get-caller-identity" />
            {!principalUnresolved && (
              <p className="text-[10px] leading-relaxed text-good">
                This backend is authenticating as{" "}
                <code className="break-all">{scannerPrincipal}</code>, which is already filled into
                step 2.
              </p>
            )}
            {principalUnresolved && (
              <p className="rounded border border-warn/40 bg-warn/10 px-2 py-1.5 text-[10px] leading-relaxed text-warn">
                <strong>Do not run the command above as it stands.</strong> This backend has no
                working credentials yet, so it cannot tell you its own identity and step 2 carries
                placeholders — deployed as-is it names a principal that does not exist, and
                CloudFormation fails with <code>Invalid principal in policy</code> without saying
                which part was wrong. {c.scannerPrincipalNote ?? ""}
                {c.containerised && (
                  <> Running in a container, credentials also have to reach it — see step 3.</>
                )}
              </p>
            )}
            <Why>
              <p>
                Those two policies are for <em>you</em>, to create the role once. They are not what
                Sightline ends up with — the role this creates grants{" "}
                <strong className="text-ink-300">SecurityAudit</strong> and{" "}
                <strong className="text-ink-300">ViewOnlyAccess</strong> plus an explicit{" "}
                <strong className="text-ink-300">Deny</strong> on reading your data: no{" "}
                <code>s3:GetObject</code>, <code>secretsmanager:GetSecretValue</code>,{" "}
                <code>dynamodb:GetItem</code>, <code>ssm:GetParameter</code> or{" "}
                <code>sqs:ReceiveMessage</code>. A Deny in IAM cannot be overridden by any Allow, so
                that holds even if AWS later widens one of those managed policies.
              </p>
              <p>
                Least privilege for this step alone is <code>cloudformation:*</code> on the one
                stack plus <code>iam:CreateRole</code>, <code>iam:PutRolePolicy</code>,{" "}
                <code>iam:AttachRolePolicy</code>, <code>iam:TagRole</code> and their delete
                counterparts for rollback. The two managed policies are the shortcut, not the
                recommendation.
              </p>
              <p>
                Read <code className="text-ink-300">infra/readonly-role.yaml</code> before deploying
                it. ADR-007 in <code>docs/DECISIONS.md</code> explains every change made to the
                template Sightline supplied.
              </p>
            </Why>
          </Step>

          {/* ---- 2. create the role --------------------------------------- */}
          <Step n={2} title="Create the role in your account">
            <p className="text-[11px] leading-relaxed text-ink-400">
              Creates one IAM role and nothing else. Copy the <code>RoleArn</code> it prints.
            </p>
            <Copyable value={deployCommand} />
            <Fields
              rows={[
                principalUnresolved
                  ? {
                      name: "SightlineScannerRoleArn",
                      kind: "replace" as const,
                      note: "NOT filled in — every angle-bracketed part is a placeholder, the role name included. Use the Arn from `aws sts get-caller-identity`, converting assumed-role/Foo/session to role/Foo.",
                    }
                  : {
                      name: "SightlineScannerRoleArn",
                      kind: "filled" as const,
                      note: "the identity this backend runs as. Not the role being created — see below.",
                    },
                {
                  name: "ExternalId",
                  kind: "filled" as const,
                  note: externalIdReady
                    ? "generated for you, not stored anywhere. The same value goes in step 3 and they must match byte for byte."
                    : "still generating — wait for it rather than copying the command now.",
                },
                {
                  name: "--profile",
                  kind: "optional" as const,
                  note: "add it if your default profile is not the target account",
                },
              ]}
            />
            {!externalIdReady && (
              <p className="rounded border border-warn/40 bg-warn/10 px-2 py-1.5 text-[10px] leading-relaxed text-warn">
                {externalId.isError
                  ? "Could not generate an ExternalId. Use any long random string of your own — it only has to be identical in steps 2 and 3."
                  : "Waiting for the ExternalId. The command above carries a placeholder until it arrives."}
              </p>
            )}
            <Why label="Two roles are involved, and confusing them is the usual mistake">
              <p>
                <code>SightlineScannerRoleArn</code> is an <em>input</em> — the principal permitted
                to assume the new role. The stack then <em>creates</em> a different role,{" "}
                <code>SightlineReadOnlyRole</code>, and its <code>RoleArn</code> output is what step
                3 wants. Pointing <code>AWS_TARGET_ROLE_ARN</code> at the scanner principal instead
                gives <code>AccessDenied</code>, or <code>NoSuchEntity</code> if it does not exist.
              </p>
              {c.scannerPrincipalConverted && c.callerIdentity && (
                <p>
                  <strong className="text-ink-300">The ARN was converted.</strong>{" "}
                  <code>get-caller-identity</code> reports the <em>session</em>, so it returns{" "}
                  <code className="break-all">{c.callerIdentity}</code> — an <code>sts</code> ARN. A
                  trust policy needs the <code>iam</code> identity behind it, which is what the
                  command uses; the <code>sts</code> form fails the template&apos;s own parameter
                  pattern.
                </p>
              )}
              <p>
                The ExternalId is a secret unique to you. The trust policy requires it, so knowing
                the role&apos;s ARN is not enough to assume it — this is what stops a third party
                tricking Sightline into using its access against your account.
              </p>
              <p>
                The trust policy names <em>one principal</em>, not the whole account. In production
                Sightline would host this template at a stable URL and give you a one-click
                CloudFormation link; the CLI form is used here because the template lives in this
                repository.
              </p>
            </Why>
          </Step>

          {/* ---- 3. configure -------------------------------------------- */}
          <Step n={3} title="Point this deployment at the role">
            <p className="text-[11px] leading-relaxed text-ink-400">
              Add these to <code className="text-ink-300">.env</code> in the repository root.
            </p>
            <Copyable value={envSnippet} />
            <Fields
              rows={[
                {
                  name: "AWS_TARGET_ROLE_ARN",
                  kind: "replace",
                  note: "the only value here that is yours. Paste the stack's RoleArn output from step 2.",
                },
                {
                  name: "AWS_SCAN_REGIONS",
                  kind: "optional",
                  note: "empty discovers every enabled region; a comma-separated list narrows it",
                },
                ...(c.containerised
                  ? [
                      {
                        name: "COMPOSE_PATH_SEPARATOR, COMPOSE_FILE",
                        kind: "filled" as const,
                        note: "give this container your ~/.aws profile. Paste them as they are.",
                      },
                    ]
                  : []),
              ]}
            />
            <p className="text-[10px] leading-relaxed text-warn">
              Delete <code>AWS_ENDPOINT_URL</code> if it still points at the mock — the AWS SDK
              reads it from the environment itself, so leaving it sends every request to moto. The
              API removes it and warns on startup, but deleting it is cleaner.
            </p>
            <Why label="Why there is no form here">
              <p>
                This API has no authentication. A page that accepted a role ARN and an ExternalId
                would be an open endpoint that assumes a role into an AWS account and stores a
                credential — so configuring the connection stays a deliberate act by someone with
                access to the host. A multi-tenant version would put authentication, per-tenant
                isolation and encrypted secret storage in place first, and only then offer the form.
              </p>
            </Why>
          </Step>

          {/* ---- 4. restart ---------------------------------------------- */}
          <Step n={4} title={c.containerised ? "Recreate the API" : "Restart the API"}>
            <p className="text-[11px] leading-relaxed text-ink-400">
              Configuration is read once at startup, so an edit with no restart changes nothing.
            </p>
            <Copyable value={restartCommand} />
            {c.containerised ? (
              <p className="text-[10px] leading-relaxed text-warn">
                Not <code>docker compose restart api</code> — that reuses the environment resolved
                when the container was created, so it exits successfully and ignores your edit.
              </p>
            ) : (
              <p className="text-[10px] leading-relaxed text-ink-400">
                In the containerised setup it is <code>docker compose --profile app up -d api</code>{" "}
                instead — recreated, not restarted.
              </p>
            )}
          </Step>

          {/* ---- 5. verify ----------------------------------------------- */}
          <Step n={5} title="Check it works" done={test.data?.ok === true}>
            <p className="text-[11px] leading-relaxed text-ink-400">
              <code>AssumeRole</code> then <code>GetCallerIdentity</code> — two read-only calls that
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
                    expires: {new Date(test.data.expiresAt ?? "").toLocaleTimeString()} (renewed
                    automatically)
                  </div>
                </div>
              </div>
            )}

            {test.data && !test.data.ok && (
              <div className="rounded border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-[11px] text-danger">
                <strong>{test.data.problem}</strong>
                <p className="mt-1 whitespace-pre-line leading-relaxed opacity-90">
                  {test.data.fix}
                </p>
                {test.data.code && (
                  <p className="mt-1 font-mono text-[10px] opacity-70">{test.data.code}</p>
                )}
              </div>
            )}

            {test.isError && <p className="text-[11px] text-danger">{test.error.message}</p>}
          </Step>
        </div>
      </details>

      <div className="border-t border-ink-800 pt-3">
        <button
          onClick={() => setShowAccess((v) => !v)}
          className="text-[11px] text-ink-400 transition hover:text-ink-200"
        >
          {showAccess ? "▾" : "▸"} What access this grants, and how to revoke it
        </button>
        {showAccess && (
          <div className="mt-1.5 space-y-1.5 text-[11px] leading-relaxed text-ink-400">
            <p>
              <strong className="text-ink-300">Granted:</strong> <code>SecurityAudit</code> and{" "}
              <code>ViewOnlyAccess</code> — enough to list resources and read their configuration.
            </p>
            <p>
              <strong className="text-ink-300">Explicitly denied:</strong> reading your actual data
              — <code>s3:GetObject</code>, <code>secretsmanager:GetSecretValue</code>,{" "}
              <code>dynamodb:GetItem</code>, <code>ssm:GetParameter</code>,{" "}
              <code>sqs:ReceiveMessage</code>. A Deny cannot be overridden by any Allow. This is why
              the commonly-used <code>ReadOnlyAccess</code> policy is deliberately not used: it
              permits reading object and secret contents, which an inventory tool never needs.
            </p>
            <p>
              <strong className="text-ink-300">To revoke:</strong> delete the CloudFormation stack.
              Sightline holds no credentials of yours, so removing the role removes all access
              immediately.
            </p>
          </div>
        )}
      </div>
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
