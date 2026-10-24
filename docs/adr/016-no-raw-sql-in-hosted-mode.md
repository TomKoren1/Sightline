# ADR-016: Hosted mode does not offer the agent its raw-SQL tool

**Status:** accepted

The agent has curated tools, each a query written and reviewed in advance,
and one escape hatch, `inventory_sql`: a single parsed `SELECT` over views
pinned to one scan, read-only, on a timeout, under the tenant's row-level
security (`agent/sqlGuard.ts`).

In a self-hosted deployment the one tenant is the operator, and the hatch
answers questions nobody anticipated. In hosted mode every tenant's model
session can write SQL, and the SQL guard becomes the barrier against the
cleverest prompt any customer - or anything planted in their account - can
produce. So hosted mode does not offer the tool, and the dispatch refuses it
independently (`availableTools()` in `agent/toolDefinitions.ts`, and the dispatch in `agent/tools.ts`), because
a model can call a tool it was never offered.

Row-level security and the scan-pinned views still apply underneath, so this
is defence in depth, not the only lock. The refusal is counted
(`sightline_agent_raw_query_refused_total{reason="hosted"}`): a rising count is
a sign the curated tools have a gap, and the fix is a new curated tool.
