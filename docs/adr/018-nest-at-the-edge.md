# ADR-018: NestJS is the HTTP edge only; the domain is plain modules

**Status:** accepted

Nest provides the HTTP edge: controllers, the global guard, interceptors,
filters and the modules that list them. Everything behind it - scanning,
analysis, the graph queries, the agent, the queue, tenancy - is plain
TypeScript modules with explicit imports, holding their few singletons (the
database pools, the parsed settings) at module level.

Considered: injecting the domain through Nest providers. It would let a test
swap a dependency through the container, and allow per-request scoping. But
the worker and the CLIs run the same domain code without a Nest application,
the tests already substitute dependencies with `vi.mock` or by passing them
in, and per-request state already has one mechanism - `withTenant`'s
AsyncLocalStorage context. Two dependency systems would be worse than one.

Considered: dropping Nest for plain Fastify plugins. Its guard, interceptor
and metadata model carries real weight here - the global auth guard with
`@MinRole`, `@HumanOnly` and `@RecentSignIn`, the tenant-scope, audit and
tracing interceptors, and the route table the enforcement and contract tests
read. Rewriting that is risk for no product change.

So: Nest imports stay in `*.controller.ts`, `*.module.ts`, `*.guard.ts`,
`*.interceptor.ts`, `*.decorator.ts`, `*.filter.ts` and `*.service.ts`, plus
three files with a reason each - `app.ts` (the composition root),
`core/access.ts` (the route metadata decorators) and
`tenancy/requestScope.ts` (it resolves an HTTP request's scope and answers
with HTTP errors). `infra/apiLayers.test.ts` holds the line.
