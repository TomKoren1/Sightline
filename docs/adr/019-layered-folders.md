# ADR-019: `core/` underneath, and folders that depend one way only

**Status:** accepted

Fourteen pairs of folders in `apps/api/src` once imported each other. A cycle
is where a change stops being local: neither side can be read, tested or
moved without the other.

`core/` holds what everything builds on and imports nothing else in `src`:
the parsed settings (`config.ts`, including the import-time environment
scrubbing), branded ids, `Scope`, `ScanTarget`, the request and session types,
the role and route-metadata decorators, paths and the version. The AWS side
of configuration lives in `aws/settings.ts`, which builds on it.

`infra/apiLayers.test.ts` requires the folder graph to be acyclic at every
length, no import cycles between files, `core/` to stay a leaf, and the mock
AWS package to be reached only from `evals/` and `cli/`. When a new import
would close a cycle, the usual fix is the one used here: the thing both
sides need is a type or a pure function, and it belongs in `core/` or in the
lower of the two folders.

Considered: splitting `apps/api` into workspace packages - scanner, agent,
HTTP. Folders under an enforced, acyclic layering already give each part a
boundary its imports cannot cross; separate packages would add a build and
a version per part for no boundary that the test does not already hold. If
a part ever needs to ship on its own, its folder is already the package.
