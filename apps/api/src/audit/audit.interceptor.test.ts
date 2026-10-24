import { firstValueFrom, of, EMPTY, type Observable } from "rxjs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CallHandler, ExecutionContext } from "@nestjs/common";

const recorded: unknown[] = [];
vi.mock("./audit.js", () => ({
  clientIp: () => "203.0.113.5",
  recordAudit: (entry: unknown) => {
    recorded.push(entry);
    return Promise.resolve();
  },
}));

const { AuditInterceptor } = await import("./audit.interceptor.js");

function context(method: string, url: string, params: Record<string, string> = {}) {
  const req = {
    method,
    url,
    routeOptions: { url },
    params,
    tenantId: "t-1",
    session: { userId: "u-1", tenantId: "t-1" },
    headers: {},
    log: { error: vi.fn() },
  };
  return {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ statusCode: 202 }) }),
  } as unknown as ExecutionContext;
}

const run = (ctx: ExecutionContext, handled: Observable<unknown> = of({ ok: true })) =>
  firstValueFrom(new AuditInterceptor().intercept(ctx, { handle: () => handled } as CallHandler));

beforeEach(() => {
  recorded.length = 0;
});

describe("the audit interceptor", () => {
  it("records a change with its route, parameters, status, actor and address", async () => {
    await run(context("DELETE", "/api/connections/:id", { id: "c-9" }));
    expect(recorded).toEqual([
      {
        tenantId: "t-1",
        actorUserId: "u-1",
        action: "DELETE /api/connections/:id",
        subject: "c-9",
        detail: { params: { id: "c-9" }, status: 202 },
        ip: "203.0.113.5",
      },
    ]);
  });

  it("passes the handler's value through untouched", async () => {
    expect(await run(context("POST", "/api/scans"))).toEqual({ ok: true });
  });

  it("records a streaming handler that completes without a value", async () => {
    await run(context("POST", "/api/scans"), EMPTY);
    expect(recorded).toHaveLength(1);
  });

  it("records no reads, and leaves the team routes to their own entries", async () => {
    await run(context("GET", "/api/findings"));
    await run(context("POST", "/api/team/invites"));
    expect(recorded).toEqual([]);
  });
});
