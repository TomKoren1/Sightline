/**
 * The limits, against a real Postgres.
 *
 * Counted in the database rather than in memory, so a fake would be testing a
 * different implementation. The interesting cases are the ones where a limit
 * must *not* fire: a self-hosted operator rationed out of scanning their own
 * account, or a first scan refused because a cooldown measured from nothing.
 *
 * `cfg` is read at import, so the environment is set before the module loads
 * and reset afterwards - which is why this file imports lazily inside each
 * block rather than at the top.
 *
 * Requires Postgres; skipped without it.
 */

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import { db } from "../db/postgres.js";
import { connections, conversations, messages, scanJobs, scanRuns, tenants } from "../db/schema.js";
import { asConnectionId, asTenantId } from "./ids.js";
import type { Scope } from "./scope.js";

const HAS_INFRA = !process.env["SKIP_INTEGRATION"];
const ORIGINAL = { ...process.env };

const tenantId = asTenantId(randomUUID());
const scope: Scope = { tenantId, connectionId: asConnectionId(randomUUID()) };
const secondScope: Scope = { tenantId, connectionId: asConnectionId(randomUUID()) };

let available = false;

beforeAll(async () => {
  if (!HAS_INFRA) return;
  try {
    await db.execute("SELECT 1");
  } catch {
    return;
  }
  available = true;

  await db.insert(tenants).values({ id: tenantId, name: "limits.test" });
  for (const s of [scope, secondScope]) {
    await db.insert(connections).values({
      id: s.connectionId,
      tenantId: s.tenantId,
      kind: "demo",
      label: "limits.test",
      externalIdSource: "demo",
    });
  }
});

afterAll(async () => {
  if (!available) return;
  await db.delete(tenants).where(eq(tenants.id, tenantId));
});

beforeEach(async () => {
  if (!available) return;
  await db.delete(scanJobs).where(eq(scanJobs.tenantId, tenantId));
  await db.delete(scanRuns).where(eq(scanRuns.tenantId, tenantId));
  await db.delete(conversations).where(eq(conversations.tenantId, tenantId));
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

/**
 * Load the limits with a given environment.
 *
 * `vi.resetModules` so `cfg` is re-parsed: it is a module-level constant, which
 * is right for configuration and means a test that only sets `process.env`
 * would be asserting against whatever the previous import captured.
 */
async function withEnv(env: Record<string, string>) {
  const { resetModules } = await import("vitest").then((m) => ({
    resetModules: m.vi.resetModules.bind(m.vi),
  }));
  Object.assign(process.env, env);
  resetModules();
  return import("./limits.js");
}

/**
 * A finished **scan**, as far back as asked.
 *
 * A run row and not a job row, which is the distinction that made the first
 * version of the cooldown wrong: it read `scan_jobs`, this test seeded
 * `scan_jobs`, and the test therefore agreed with the implementation instead of
 * checking the requirement. A real ten-minute cooldown then failed to fire one
 * second after `npm run scan`, which creates no job row. Seeding what a scan
 * actually leaves behind is what makes the assertion mean something.
 */
async function finishedScanAgo(target: Scope, seconds: number) {
  const id = randomUUID();
  await db.insert(scanRuns).values({
    id,
    tenantId: target.tenantId,
    connectionId: target.connectionId,
    accountId: "123456789012",
    status: "succeeded",
    startedAt: new Date(),
  });
  await db.execute(sql`
    UPDATE scan_runs SET finished_at = now() - ${`${seconds} seconds`}::interval WHERE id = ${id}
  `);
}

async function queuedJob(target: Scope) {
  await db.insert(scanJobs).values({
    id: randomUUID(),
    tenantId: target.tenantId,
    connectionId: target.connectionId,
    status: "queued",
  });
}

async function askedQuestions(n: number) {
  const conversationId = randomUUID();
  await db.insert(conversations).values({
    id: conversationId,
    tenantId,
    connectionId: scope.connectionId,
    accountId: "123456789012",
  });
  if (n === 0) return;
  await db.insert(messages).values(
    Array.from({ length: n }, () => ({
      id: randomUUID(),
      tenantId,
      conversationId,
      role: "user" as const,
      content: "how many public buckets are there?",
    })),
  );
}

describe.runIf(HAS_INFRA)("the spending limits", () => {
  it("has a database to talk to", () => {
    expect(available, "Postgres is not reachable, so none of this was checked").toBe(true);
  });

  describe("a self-hosted clone", () => {
    it("is not rationed out of scanning its own account", async () => {
      if (!available) return;
      const { mayScan } = await withEnv({ DEPLOYMENT_MODE: "self-hosted" });
      // A scan that finished one second ago. A tool that makes its single
      // operator wait five minutes to rescan their own AWS account is a worse
      // tool protecting nobody - it is their account and their bill.
      await finishedScanAgo(scope, 1);

      expect(await mayScan(scope)).toEqual({ allowed: true });
    });

    it("has no chat quota, because the API key is the operator's own", async () => {
      if (!available) return;
      const { mayChat } = await withEnv({ DEPLOYMENT_MODE: "self-hosted" });
      await askedQuestions(500);

      expect(await mayChat(scope)).toEqual({ allowed: true });
    });
  });

  describe("the scan cooldown", () => {
    it("refuses a rescan too soon, and says how long", async () => {
      if (!available) return;
      const { mayScan } = await withEnv({ SCAN_COOLDOWN_SECONDS: "300" });
      await finishedScanAgo(scope, 60);

      const decision = await mayScan(scope);
      expect(decision.allowed).toBe(false);
      if (decision.allowed) return;
      // Roughly four minutes left. Asserted as a range because the clock moves
      // between the insert and the check.
      expect(decision.retryAfterSeconds).toBeGreaterThan(200);
      expect(decision.retryAfterSeconds).toBeLessThanOrEqual(240);
    });

    it("allows the first scan a connection ever has", async () => {
      if (!available) return;
      const { mayScan } = await withEnv({ SCAN_COOLDOWN_SECONDS: "300" });

      /**
       * The case a cooldown gets wrong by default. With no previous job there is
       * no `finished_at`, and a naive comparison against null or against the
       * epoch either refuses every first scan or allows every scan - the first
       * being much worse, because it makes a brand-new account unusable.
       */
      expect(await mayScan(scope)).toEqual({ allowed: true });
    });

    it("allows a rescan once the cooldown has passed", async () => {
      if (!available) return;
      const { mayScan } = await withEnv({ SCAN_COOLDOWN_SECONDS: "60" });
      await finishedScanAgo(scope, 120);

      expect(await mayScan(scope)).toEqual({ allowed: true });
    });

    it("is measured per connection, so one account does not block another", async () => {
      if (!available) return;
      const { mayScan } = await withEnv({ SCAN_COOLDOWN_SECONDS: "300" });
      await finishedScanAgo(scope, 1);

      // Scanning production must not stop somebody looking at staging.
      expect(await mayScan(secondScope)).toEqual({ allowed: true });
    });
  });

  describe("the cap across a tenant's accounts", () => {
    it("refuses once too many are in flight", async () => {
      if (!available) return;
      const { mayScan } = await withEnv({ MAX_ACTIVE_SCANS_PER_TENANT: "1" });
      await queuedJob(secondScope);

      const decision = await mayScan(scope);
      expect(decision.allowed).toBe(false);
      if (decision.allowed) return;
      expect(decision.reason).toMatch(/queued or running/);
      // No retry time: this clears when a scan finishes, and guessing when
      // would be worse than not saying.
      expect(decision.retryAfterSeconds).toBeUndefined();
    });

    it("counts only jobs that are still going", async () => {
      if (!available) return;
      const { mayScan } = await withEnv({ MAX_ACTIVE_SCANS_PER_TENANT: "1" });
      // History must not count, or a tenant would be permanently at their cap
      // after their first few scans.
      await finishedScanAgo(secondScope, 99_999);

      expect(await mayScan(scope)).toEqual({ allowed: true });
    });
  });

  describe("the chat quota", () => {
    it("refuses once the hour's questions are used up", async () => {
      if (!available) return;
      const { mayChat } = await withEnv({ CHAT_QUESTIONS_PER_HOUR: "3" });
      await askedQuestions(3);

      const decision = await mayChat(scope);
      expect(decision.allowed).toBe(false);
      if (decision.allowed) return;
      expect(decision.reason).toMatch(/asked 3 questions/);
    });

    it("allows the next question below the limit", async () => {
      if (!available) return;
      const { mayChat } = await withEnv({ CHAT_QUESTIONS_PER_HOUR: "3" });
      await askedQuestions(2);

      expect(await mayChat(scope)).toEqual({ allowed: true });
    });

    it("does not count the assistant's own replies against the asker", async () => {
      if (!available) return;
      const { mayChat } = await withEnv({ CHAT_QUESTIONS_PER_HOUR: "3" });
      const conversationId = randomUUID();
      await db.insert(conversations).values({
        id: conversationId,
        tenantId,
        connectionId: scope.connectionId,
        accountId: "123456789012",
      });
      // Two questions and two answers. Counting both roles would put this at
      // the limit having asked two of three - halving the quota somebody was
      // told they had.
      await db.insert(messages).values(
        ["user", "assistant", "user", "assistant"].map((role) => ({
          id: randomUUID(),
          tenantId,
          conversationId,
          role: role as "user" | "assistant",
          content: "x",
        })),
      );

      expect(await mayChat(scope)).toEqual({ allowed: true });
    });

    it("forgets questions older than the window", async () => {
      if (!available) return;
      const { mayChat } = await withEnv({ CHAT_QUESTIONS_PER_HOUR: "2" });
      await askedQuestions(5);
      await db.execute(sql`
        UPDATE messages SET created_at = now() - interval '2 hours' WHERE tenant_id = ${tenantId}
      `);

      // A rolling window, not a running total: otherwise the limit is a
      // lifetime cap and the wording about resetting is a lie.
      expect(await mayChat(scope)).toEqual({ allowed: true });
    });
  });

  describe("the kill switches", () => {
    it("is a 503 and not a 429, because the caller did nothing wrong", async () => {
      if (!available) return;
      const { mayScan, mayChat, statusFor } = await withEnv({
        SCANS_ENABLED: "false",
        CHAT_ENABLED: "false",
      });

      /**
       * Both were 429 to begin with, which reads as "you have made too many
       * requests" to somebody who made one. A client with retry logic backs off
       * as though it were at fault, and a user is told something untrue about
       * their own behaviour.
       */
      for (const decision of [await mayScan(scope), await mayChat(scope)]) {
        expect(decision.allowed).toBe(false);
        if (decision.allowed) continue;
        expect(decision.kind).toBe("paused");
        expect(statusFor(decision.kind)).toBe(503);
      }
    });

    it("is a 429 when the caller's own usage caught up with them", async () => {
      if (!available) return;
      const { mayScan, statusFor } = await withEnv({ SCAN_COOLDOWN_SECONDS: "300" });
      await finishedScanAgo(scope, 10);

      const decision = await mayScan(scope);
      expect(decision.allowed).toBe(false);
      if (decision.allowed) return;
      expect(decision.kind).toBe("throttled");
      expect(statusFor(decision.kind)).toBe(429);
    });

    it("stops scans at the enqueue and at the worker", async () => {
      if (!available) return;
      const { mayScan, scanningEnabled } = await withEnv({ SCANS_ENABLED: "false" });

      /**
       * Both ends. Refusing only at the API lets an existing backlog keep
       * running; refusing only at the worker lets tenants queue jobs that never
       * move and look stuck.
       */
      expect(scanningEnabled()).toBe(false);
      const decision = await mayScan(scope);
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.reason).toMatch(/turned off/);
    });

    it("stops chat without claiming the rest of the product is broken", async () => {
      if (!available) return;
      const { mayChat } = await withEnv({ CHAT_ENABLED: "off" });

      const decision = await mayChat(scope);
      expect(decision.allowed).toBe(false);
      // The graph and findings still work, and saying so is the difference
      // between a disabled feature and an outage.
      if (!decision.allowed) expect(decision.reason).toMatch(/graph and the findings/);
    });

    it("is not defeated by the string 'false'", async () => {
      if (!available) return;
      /**
       * The bug this replaced. `z.coerce.boolean()` applies `Boolean()`, under
       * which every non-empty string is true - so `SCANS_ENABLED=false` left
       * scanning on, silently, in the direction nobody wants, during whatever
       * incident prompted somebody to set it.
       */
      for (const off of ["false", "FALSE", "0", "no", "off"]) {
        const { scanningEnabled } = await withEnv({ SCANS_ENABLED: off });
        expect(scanningEnabled(), `SCANS_ENABLED=${off} should turn scanning off`).toBe(false);
      }
      for (const on of ["true", "1", "yes", "on"]) {
        const { scanningEnabled } = await withEnv({ SCANS_ENABLED: on });
        expect(scanningEnabled(), `SCANS_ENABLED=${on} should leave scanning on`).toBe(true);
      }
    });
  });

  describe("the resource ceiling", () => {
    it("allows a scan at the limit and refuses one above it", async () => {
      if (!available) return;
      const { tooManyResources } = await withEnv({ MAX_RESOURCES_PER_SCAN: "1000" });

      expect(tooManyResources(1000)).toEqual({ allowed: true });
      const refused = tooManyResources(1001);
      expect(refused.allowed).toBe(false);
      if (refused.allowed) return;
      // The message has to say what to do, because "too many resources" with
      // no number and no lever is indistinguishable from a bug.
      expect(refused.reason).toMatch(/1,001/);
      expect(refused.reason).toMatch(/MAX_RESOURCES_PER_SCAN/);
      expect(refused.reason).toMatch(/nothing you were already looking at has changed/);
    });
  });
});
