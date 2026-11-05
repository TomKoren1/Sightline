# Architecture decisions

Short records of decisions the code depends on, each with the reason, so a
later change can disagree with the reason rather than rediscover it. Earlier
decisions live in commit messages and the comments where they apply; these
are the ones the code cites by number.

The project's earlier decision log, `docs/DECISIONS.md`, was retired in
`21e06c4` (`git show 21e06c4^:docs/DECISIONS.md`). Its numbers are not these:
an ADR number cited in code or docs means this directory. Records here were
numbered 016-019 until they were renumbered from 001.

| ADR                                     | Decision                                                    |
| --------------------------------------- | ----------------------------------------------------------- |
| [001](001-no-raw-sql-in-hosted-mode.md) | Hosted mode does not offer the agent its raw-SQL tool       |
| [002](002-explicit-injection-tokens.md) | No decorator metadata; every Nest injection names its token |
| [003](003-nest-at-the-edge.md)          | NestJS is the HTTP edge only; the domain is plain modules   |
| [004](004-layered-folders.md)           | `core/` underneath, and folders that depend one way only    |
