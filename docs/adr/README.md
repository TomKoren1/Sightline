# Architecture decisions

Short records of decisions the code depends on, each with the reason, so a
later change can disagree with the reason rather than rediscover it. Earlier
decisions live in commit messages and the comments where they apply; these
are the ones the code cites by number.

| ADR                                     | Decision                                                    |
| --------------------------------------- | ----------------------------------------------------------- |
| [016](016-no-raw-sql-in-hosted-mode.md) | Hosted mode does not offer the agent its raw-SQL tool       |
| [017](017-explicit-injection-tokens.md) | No decorator metadata; every Nest injection names its token |
| [018](018-nest-at-the-edge.md)          | NestJS is the HTTP edge only; the domain is plain modules   |
| [019](019-layered-folders.md)           | `core/` underneath, and folders that depend one way only    |
