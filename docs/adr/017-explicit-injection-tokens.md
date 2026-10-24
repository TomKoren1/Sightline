# ADR-017: No decorator metadata; every Nest injection names its token

**Status:** accepted

`emitDecoratorMetadata` needs type information, and the code is transpiled by
esbuild - through tsx in development, vitest in tests and `apps/api/build.mjs`
for the production image - which cannot emit it. Nest does not fail loudly
without it: an unannotated constructor parameter is injected as `undefined`
and the handler throws at the first request.

So `tsconfig.json` sets `experimentalDecorators` and not
`emitDecoratorMetadata`, and every constructor injection names its token:
`constructor(@Inject(GraphService) private readonly graph: GraphService)`.
A missing `@Inject` shows up as a 500 on the first request to that controller,
and the contract tests make one request to every route.

The alternative - compiling with `tsc` to get metadata - would make the
production build differ from the one developed and tested against.
