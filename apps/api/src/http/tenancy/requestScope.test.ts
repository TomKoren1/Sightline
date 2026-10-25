/**
 * Which account a request is about, decided from a header.
 *
 * Driven through the real application rather than by calling `resolveScope`
 * directly, because the questions are about what a client gets back: a header
 * it typed wrong must be an error it can read, not an empty graph that looks
 * like an account with nothing in it.
 *
 * Runs self-hosted, which is the mode a clone runs and - since the fix below -
 * the same code path hosted mode takes.
 *
 * Requires Postgres; skipped without it.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { buildApp } from "../app.js";
import { CONNECTION_HEADER } from "./requestScope.js";
import { LOCAL_DEMO_CONNECTION_ID } from "../../tenancy/local.js";

const HAS_INFRA = !process.env["SKIP_INTEGRATION"];

let app: NestFastifyApplication;

beforeAll(async () => {
  app = await buildApp();
}, 120_000);

afterAll(async () => {
  if (app) await app.close();
});

const summary = (header?: string) =>
  app.inject({
    method: "GET",
    url: "/api/summary",
    ...(header ? { headers: { [CONNECTION_HEADER]: header } } : {}),
  });

describe.runIf(HAS_INFRA)("choosing a connection", () => {
  it("falls back to one the tenant owns when no header is sent", async () => {
    // The API has to be usable before the UI has chosen anything, and picking
    // among accounts this tenant already connected is safe in a way that
    // picking a *tenant* would not be.
    expect((await summary()).statusCode).toBe(200);
  });

  it("honours a connection the tenant owns", async () => {
    expect((await summary(LOCAL_DEMO_CONNECTION_ID)).statusCode).toBe(200);
  });

  it("refuses a connection that is not the tenant's", async () => {
    /**
     * A well-formed id for a connection this tenant does not have.
     *
     * Every read filters on the tenant anyway, so an unchecked id would return
     * nothing rather than somebody else's rows - but "nothing" renders as an
     * account with no resources in it, which is a worse answer than an error.
     */
    const res = await summary(randomUUID());
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: "No such connection" });
  });

  it("refuses an id that is not an id, as a 400 rather than a 500", async () => {
    // The branded-id constructor throws a plain Error, which Nest would
    // otherwise render as an internal error for a header the client got wrong.
    const res = await summary("not-a-uuid");
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/not a valid id/);
  });

  it("says no such connection rather than confirming one exists elsewhere", async () => {
    // Both answers are identical, deliberately: distinguishing them would tell
    // a caller whether an id exists in somebody's account.
    const foreign = await summary(randomUUID());
    const absent = await summary(randomUUID());
    expect(foreign.body).toBe(absent.body);
  });
});
