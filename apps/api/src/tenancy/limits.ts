/**
 * What a tenant is allowed to spend.
 *
 * Every limit bounds something that costs real money - AWS calls and worker
 * memory for a scan, Anthropic tokens for a question - so the defaults move
 * with the deployment mode: a clone's operator needs no protection from
 * themselves.
 *
 * These return a decision rather than throwing. A refusal is an ordinary answer
 * ("not yet, and here is when"), and the caller turns it into the right status;
 * throwing invites one escaping as a 500 to somebody who is merely early.
 *
 * Counted in Postgres, not in memory, for the same reason the queue is: a count
 * held in one process gives each replica its own quota.
 */

import { and, count, eq, gte, sql } from "drizzle-orm";

import { cfg, chatQuestionsPerHour, chatTokensPerDay, scanCooldownSeconds } from "../config.js";
import { db, withTenant } from "../db/postgres.js";
import { messages, scanJobs, scanRuns } from "../db/schema.js";
import type { Scope } from "./scope.js";

/**
 * Why a refusal happened, so the caller can say it in the right status.
 *
 * `throttled` is the caller's own usage catching up with them - a cooldown, a
 * cap - and is a 429. `paused` is the operator having turned something off, and
 * is a 503: telling somebody who made one request that they have made too many
 * is both untrue and actively misleading, and a client with retry logic would
 * back off as though it were at fault.
 */
export type RefusalKind = "throttled" | "paused";

/**
 * Allowed, or refused with something a person can act on.
 *
 * `retryAfterSeconds` is present whenever waiting is the answer, so a caller
 * can set `Retry-After` and the UI can say how long rather than "try again
 * later", which is the difference between a limit and a brick wall.
 */
export type Decision =
  | { allowed: true }
  | { allowed: false; kind: RefusalKind; reason: string; retryAfterSeconds?: number };

const ALLOWED: Decision = { allowed: true };

/** The status for a refusal. The one place HTTP meets these decisions. */
export function statusFor(kind: RefusalKind): 429 | 503 {
  return kind === "paused" ? 503 : 429;
}

/**
 * May this tenant start a scan of this account?
 *
 * Does **not** check "is one already running" - that is the partial unique
 * index on `scan_jobs`, and checking it here as well would be a second opinion
 * that can disagree with the one the database enforces. These are the limits
 * the index cannot express.
 */
export async function mayScan(scope: Scope): Promise<Decision> {
  return withTenant(scope.tenantId, async () => {
    if (!cfg.SCANS_ENABLED) {
      return {
        allowed: false,
        kind: "paused",
        reason:
          "Scanning is turned off on this deployment while an operator looks at something. " +
          "Nothing you have already scanned is affected.",
      };
    }

    const cooldown = scanCooldownSeconds();
    if (cooldown > 0) {
      /**
       * From `scan_runs`, not `scan_jobs`.
       *
       * The first version read the queue, and a cooldown of ten minutes did not
       * fire one second after a scan: `npm run scan` goes through the same
       * pipeline but creates no job row, so the queue has no record of it. The
       * question being asked is "when was this account last scanned", and the
       * answer to that lives with the scan. Every scan has a run row however it
       * was started.
       *
       * Measured from when it *finished*, not when it started: from the start, a
       * slow scan would eat its own cooldown and a fast account could be rescanned
       * in a loop. From the finish, the gap is a gap.
       */
      // Elapsed by the database's clock alone: finished_at was written by it,
      // and comparing it with this process's clock made the wait off by
      // however far the two disagree.
      const [last] = await db
        .select({
          elapsed: sql<
            number | null
          >`extract(epoch from now() - max(${scanRuns.finishedAt}))::float8`,
        })
        .from(scanRuns)
        .where(
          and(eq(scanRuns.tenantId, scope.tenantId), eq(scanRuns.connectionId, scope.connectionId)),
        );

      const elapsed = last?.elapsed ?? null;
      if (elapsed !== null) {
        const remaining = cooldown - Number(elapsed);
        if (remaining > 0) {
          const wait = Math.max(1, Math.ceil(remaining));
          return {
            allowed: false,
            kind: "throttled",
            reason:
              `This account was scanned less than ${Math.round(cooldown / 60)} minute(s) ago. ` +
              `You can scan it again in ${wait} second(s) — an inventory does not usually ` +
              "change faster than that, and each scan costs API calls against your account.",
            retryAfterSeconds: wait,
          };
        }
      }
    }

    /**
     * A cap across the tenant's accounts, which the per-connection index cannot
     * express: somebody with fifty connected accounts could otherwise queue fifty
     * scans at once and own every worker.
     */
    const [active] = await db
      .select({ n: count() })
      .from(scanJobs)
      .where(
        and(eq(scanJobs.tenantId, scope.tenantId), sql`${scanJobs.status} IN ('queued','running')`),
      );

    const running = Number(active?.n ?? 0);
    if (running >= cfg.MAX_ACTIVE_SCANS_PER_TENANT) {
      return {
        allowed: false,
        kind: "throttled",
        reason:
          `You already have ${running} scan(s) queued or running, which is the limit. ` +
          "Wait for one to finish and this will work.",
      };
    }

    return ALLOWED;
  });
}

/** May this tenant ask the agent a question? */
export async function mayChat(scope: Scope): Promise<Decision> {
  return withTenant(scope.tenantId, async () => {
    if (!cfg.CHAT_ENABLED) {
      return {
        allowed: false,
        kind: "paused",
        reason:
          "The assistant is turned off on this deployment while an operator looks at something. " +
          "The graph and the findings are unaffected.",
      };
    }

    const perHour = chatQuestionsPerHour();
    if (perHour === null) return tokenBudget(scope);

    const since = new Date(Date.now() - 60 * 60 * 1000);
    /**
     * The tenant's own questions in the last hour.
     *
     * `role = 'user'` so the agent's own replies do not count against the person
     * who asked - the number a user can reason about is how many questions they
     * asked, and counting both would halve the quota they were told they had.
     */
    const [asked] = await db
      .select({ n: count() })
      .from(messages)
      .where(
        and(
          eq(messages.tenantId, scope.tenantId),
          eq(messages.role, "user"),
          gte(messages.createdAt, since),
        ),
      );

    const used = Number(asked?.n ?? 0);
    if (used >= perHour) {
      return {
        allowed: false,
        kind: "throttled",
        reason:
          `You have asked ${used} questions in the last hour, which is this deployment's limit. ` +
          "The limit resets as your earlier questions age out.",
        // Deliberately not computed from the oldest message in the window. That
        // would be more precise and would also tell a caller exactly when to
        // retry hardest; an hour is the honest upper bound and costs no query.
        retryAfterSeconds: 60 * 60,
      };
    }

    return tokenBudget(scope);
  });
}

/**
 * The tenant's answers in the last 24 hours, in tokens. Inside `mayChat`'s
 * tenant context. Counts what was spent before this question, so the one
 * that crosses the line is answered and the next is refused.
 */
async function tokenBudget(scope: Scope): Promise<Decision> {
  const perDay = chatTokensPerDay();
  if (perDay === null) return ALLOWED;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [spent] = await db
    .select({
      n: sql<number>`coalesce(sum(${messages.inputTokens} + ${messages.outputTokens}), 0)::int`,
    })
    .from(messages)
    .where(
      and(
        eq(messages.tenantId, scope.tenantId),
        eq(messages.role, "assistant"),
        gte(messages.createdAt, since),
      ),
    );
  const used = Number(spent?.n ?? 0);
  if (used < perDay) return ALLOWED;
  return {
    allowed: false,
    kind: "throttled",
    reason:
      `Your questions have used ${used.toLocaleString("en-US")} model tokens in the last 24 hours, ` +
      `which is this deployment's limit of ${perDay.toLocaleString("en-US")}. Earlier answers age ` +
      "out of the window; the graph, the findings and search are unaffected.",
    retryAfterSeconds: 60 * 60,
  };
}

/**
 * Whether a scan is too big to publish as the current graph.
 *
 * Checked after collection, so it bounds the graph rather than the scan's own
 * peak memory - see the note on `MAX_RESOURCES_PER_SCAN`.
 */
export function tooManyResources(found: number): Decision {
  const ceiling = cfg.MAX_RESOURCES_PER_SCAN;
  if (found <= ceiling) return ALLOWED;
  return {
    allowed: false,
    // Neither throttled nor paused: nothing will change by waiting. It never
    // reaches HTTP - the scan has already started by the time this is asked -
    // so the kind is only here to keep the type honest.
    kind: "throttled",
    reason:
      `This scan found ${found.toLocaleString()} resources, above this deployment's limit of ` +
      `${ceiling.toLocaleString()}. The scan was recorded but not projected into the graph, so ` +
      "nothing you were already looking at has changed. Narrow the regions scanned, or raise " +
      "MAX_RESOURCES_PER_SCAN if the machine has the memory for it.",
  };
}

/**
 * Whether the worker should take any work at all.
 *
 * Checked at the claim as well as at the enqueue, so turning scanning off stops
 * the queue draining instead of only stopping it filling. Both ends, because
 * either alone leaves a surprise: refusing only at the API lets a backlog keep
 * running, and refusing only at the worker lets a tenant queue jobs that never
 * move and look stuck.
 */
export function scanningEnabled(): boolean {
  return cfg.SCANS_ENABLED;
}
