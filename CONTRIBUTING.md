# Contributing

Thanks for taking a look. Issues and pull requests are welcome.

## Getting started

You need Node 22 (see `.nvmrc`) and Docker. Nothing else; there's no AWS account
and no API key.

```bash
npm ci
docker compose up -d     # Postgres and the mock AWS account
npm run seed             # build the fictional customer account
npm run scan             # scan it
npm run dev:api          # http://localhost:3000
npm run dev:web          # http://localhost:5173
```

[`docs/development.md`](docs/development.md) has every command, the configuration
and the house style.

## Before you open a pull request

- Run `npm run verify`. It runs everything CI's static job runs: types, Prettier,
  ESLint, the unit tests and the frontend build.
- Add a test with the change. Tests sit next to the code (`*.test.ts`). Checks that
  hold two files in agreement, such as a manifest and the code it configures, go
  in [`guards/`](guards/).
- A change to an analyser has to keep the tier-1 ground-truth checks passing. The
  answer key in `packages/mock-aws/src/topology.ts` is written by hand; never
  generate it from the code under test.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:`, `fix:`, `docs:`, ...).
- A decision that later code depends on gets an ADR in [`docs/adr/`](docs/adr/README.md).

## Security

Please don't report vulnerabilities in public issues. [SECURITY.md](SECURITY.md)
explains how to report one privately.
