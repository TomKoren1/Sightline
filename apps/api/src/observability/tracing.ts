/**
 * Traces across API -> queue -> worker -> AWS and the model, when asked for.
 *
 * Off unless OTEL_EXPORTER_OTLP_ENDPOINT is set; then spans go to that OTLP
 * collector (Tempo, Jaeger, any OTLP endpoint) per the standard OTEL_*
 * variables. Off, the SDK is never loaded and every span is the API's no-op.
 * Spans are written by hand where time goes - a request, a scan and its units,
 * an AWS call, an answer and its tools - since auto-instrumentation patches
 * modules at load and does not survive this build's ES module bundle. No
 * customer data in attributes: ids and operation names only.
 */

import {
  context,
  propagation,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
} from "@opentelemetry/api";

export const tracer = trace.getTracer("sightline");

let shutdown: (() => Promise<void>) | null = null;

/** Whether spans are being exported at all; callers skip work that only feeds them. */
export const tracingEnabled = (): boolean => shutdown !== null;

/** `exporter` replaces OTLP, for tests: spans are then exported as they end. */
export async function startTracing(
  serviceName: string,
  version: string,
  exporter?: import("@opentelemetry/sdk-trace-base").SpanExporter,
): Promise<void> {
  if (!exporter && !process.env["OTEL_EXPORTER_OTLP_ENDPOINT"]) return;
  const [
    { NodeTracerProvider },
    { BatchSpanProcessor, SimpleSpanProcessor },
    { OTLPTraceExporter },
    { resourceFromAttributes },
  ] = await Promise.all([
    import("@opentelemetry/sdk-trace-node"),
    import("@opentelemetry/sdk-trace-base"),
    import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/resources"),
  ]);
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      "service.name": process.env["OTEL_SERVICE_NAME"] ?? serviceName,
      "service.version": version,
    }),
    spanProcessors: [
      exporter
        ? new SimpleSpanProcessor(exporter)
        : new BatchSpanProcessor(new OTLPTraceExporter()),
    ],
  });
  // Registers the async-hooks context manager and the W3C propagator too.
  provider.register();
  shutdown = () => provider.shutdown();
}

/** Flush what is buffered, on the way out. */
export async function stopTracing(): Promise<void> {
  await shutdown?.().catch(() => undefined);
}

/** Run `fn` inside a span, recording a thrown error on it. */
export function inSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
  parent?: Context,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, parent ?? context.active(), async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err instanceof Error ? err : String(err));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}

/** The active trace as a `traceparent` header value, to carry through the queue. */
export function currentTraceparent(): string | null {
  if (!tracingEnabled()) return null;
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier["traceparent"] ?? null;
}

/** A context continuing the trace a `traceparent` names, or the current one. */
export function contextFrom(traceparent: string | null | undefined): Context {
  return traceparent ? propagation.extract(context.active(), { traceparent }) : context.active();
}
