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

So: everything that imports Nest lives in `src/http/` - the composition root
(`app.ts`, `app.module.ts`), one folder per area holding its controller,
module and service, the guard, the interceptors, the filter, and
`tenancy/requestScope.ts`, which resolves an HTTP request's scope and answers
with HTTP errors. The one exception is `core/access.ts`, the route-metadata
decorators, which domain code names when it describes who may do what. Only
the entry points (`server.ts`) and `cli/openapi.ts` import from `http/`.
`guards/apiLayers.test.ts` holds both lines.

The folders were once mixed - `scan/` beside `scans/`, `connection/` beside
`tenancy/connections.ts` - with the boundary visible only as a file suffix.
Under `http/` it is visible in the tree.
