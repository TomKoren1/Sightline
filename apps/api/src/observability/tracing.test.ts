import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  contextFrom,
  currentTraceparent,
  inSpan,
  startTracing,
  stopTracing,
  tracingEnabled,
} from "./tracing.js";

const exporter = new InMemorySpanExporter();

beforeAll(async () => {
  await startTracing("sightline-test", "0.0.0", exporter);
});
afterAll(async () => {
  await stopTracing();
});

describe("tracing", () => {
  it("is on when an exporter is configured", () => {
    expect(tracingEnabled()).toBe(true);
  });

  it("continues a trace across the queue through a traceparent", async () => {
    let carried: string | null = null;
    await inSpan("POST /api/scans", {}, () => {
      carried = currentTraceparent();
      return Promise.resolve();
    });
    expect(carried).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);

    // Later, in the worker, from the job row.
    await inSpan("scan.job", {}, () => Promise.resolve(), contextFrom(carried));
    const spans = exporter.getFinishedSpans();
    const request = spans.find((s) => s.name === "POST /api/scans")!;
    const job = spans.find((s) => s.name === "scan.job")!;
    expect(job.spanContext().traceId).toBe(request.spanContext().traceId);
    expect(job.parentSpanContext?.spanId).toBe(request.spanContext().spanId);
  });

  it("marks a span that threw as an error and rethrows", async () => {
    await expect(inSpan("fails", {}, () => Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom",
    );
    const span = exporter.getFinishedSpans().find((s) => s.name === "fails")!;
    expect(span.status.code).toBe(2);
    expect(span.events.some((e) => e.name === "exception")).toBe(true);
  });
});
