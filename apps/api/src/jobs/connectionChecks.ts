/**
 * Connection checks, asked by the API and answered by the worker.
 *
 * The identity that can assume every customer's role is the most valuable
 * secret this system holds, so only the worker has it. The onboarding screen
 * still needs a "does the role work yet?" answer in a second or two, so the
 * API writes a request, wakes the worker with `NOTIFY`, and waits on the row.
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db, system, withTenant } from "../db/postgres.js";
import { performVerification, type VerifyResult } from "../tenancy/onboarding.js";
import type { ConnectionId, TenantId } from "../core/ids.js";
import type { Scope } from "../core/scope.js";

export const CHECK_QUEUE_CHANNEL = "sightline_check_queued";

/** How long the API waits for an answer before saying the worker is not there. */
const ANSWER_TIMEOUT_MS = 25_000;
const ANSWER_POLL_MS = 250;

const NO_WORKER: VerifyResult = {
  ok: false,
  durationMs: ANSWER_TIMEOUT_MS,
  problem:
    "The scan worker did not answer within 25 seconds, so the connection could not be tested. " +
    "Check that the worker is running; the role itself may be fine.",
};

/** Ask the worker to try this connection, and wait for its answer. */
export async function requestCheck(scope: Scope): Promise<VerifyResult> {
  const id = randomUUID();
  await withTenant(scope.tenantId, async () => {
    // Housekeeping on the way in: nobody waits on an answer this old.
    await db.execute(sql`
      DELETE FROM connection_checks
       WHERE tenant_id = ${scope.tenantId} AND requested_at < now() - interval '1 hour'`);
    await db.execute(sql`
      INSERT INTO connection_checks (id, tenant_id, connection_id)
      VALUES (${id}, ${scope.tenantId}, ${scope.connectionId})`);
  });
  // On `system`: NOTIFY carries no tenant data, only "look at the table".
  await system.execute(sql`SELECT pg_notify(${CHECK_QUEUE_CHANNEL}, '')`);

  const deadline = Date.now() + ANSWER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const answer = await withTenant(scope.tenantId, async () => {
      const { rows } = await db.execute<{ status: string; result: VerifyResult | null }>(sql`
        SELECT status, result FROM connection_checks
         WHERE id = ${id} AND tenant_id = ${scope.tenantId}`);
      return rows[0];
    });
    if (answer?.status === "done" && answer.result) return answer.result;
    await new Promise((r) => setTimeout(r, ANSWER_POLL_MS));
  }
  return NO_WORKER;
}

/**
 * Take one waiting check. Across tenants, so on `system`: the worker serves
 * everybody, and learns whose check it is from the row it claims.
 */
async function claimNextCheck(workerId: string) {
  const { rows } = await system.execute<{
    id: string;
    tenant_id: TenantId;
    connection_id: ConnectionId;
  }>(sql`
    UPDATE connection_checks SET status = 'running', locked_by = ${workerId}
     WHERE id = (SELECT id FROM connection_checks WHERE status = 'queued'
                  ORDER BY requested_at LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING id, tenant_id, connection_id`);
  return rows[0] ?? null;
}

/** Answer every waiting check. Called by the worker on each wake-up. */
export async function answerChecks(workerId: string): Promise<number> {
  let answered = 0;
  for (let check = await claimNextCheck(workerId); check; check = await claimNextCheck(workerId)) {
    const scope = { tenantId: check.tenant_id, connectionId: check.connection_id };
    let result: VerifyResult;
    try {
      result = await performVerification(scope);
    } catch (err) {
      result = {
        ok: false,
        durationMs: 0,
        problem: err instanceof Error ? err.message : "The connection could not be tested.",
      };
    }
    await system.execute(sql`
      UPDATE connection_checks SET status = 'done', result = ${JSON.stringify(result)}::jsonb,
             finished_at = now()
       WHERE id = ${check.id}`);
    answered++;
  }
  return answered;
}
