/**
 * A span per request, continuing the caller's trace from `traceparent`, so a
 * scan queued here and run by the worker is one trace. A pass-through when
 * tracing is off.
 */

import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { context, propagation, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { FastifyReply, FastifyRequest } from "fastify";
import { defaultIfEmpty, firstValueFrom, from, type Observable } from "rxjs";

import { tracer, tracingEnabled } from "./tracing.js";

@Injectable()
export class TracingInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!tracingEnabled()) return next.handle();
    const http = ctx.switchToHttp();
    const req = http.getRequest<FastifyRequest>();
    const route = req.routeOptions?.url ?? "unmatched";
    const parent = propagation.extract(context.active(), req.headers);
    const span = tracer.startSpan(
      `${req.method} ${route}`,
      {
        kind: SpanKind.SERVER,
        attributes: { "http.request.method": req.method, "http.route": route },
      },
      parent,
    );
    const run = context.with(trace.setSpan(parent, span), () =>
      firstValueFrom(next.handle().pipe(defaultIfEmpty(undefined))),
    );
    return from(
      run.then(
        (value: unknown) => {
          const status = http.getResponse<FastifyReply>().statusCode;
          span.setAttribute("http.response.status_code", status);
          if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
          span.end();
          return value;
        },
        (err: unknown) => {
          span.recordException(err instanceof Error ? err : String(err));
          span.setStatus({ code: SpanStatusCode.ERROR });
          span.end();
          throw err;
        },
      ),
    );
  }
}
