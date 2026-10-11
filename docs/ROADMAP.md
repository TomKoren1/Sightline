# Limits and roadmap

Where Sightline breaks as an account gets large, in the order it would actually
happen, and what I would build next. Both are honest about the current shape
rather than aspirational: every limit below is one I can point at in the code,
and every fix is one the existing design already leaves room for.

---

## What breaks first on a large account

In the order it would actually happen:

**1. The graph rebuild, at roughly 50k resources.** Neo4j is rebuilt wholesale
in one transaction. That is simple and leaves no stale nodes, but it is O(all
resources) per scan and the transaction gets large. _Fix:_ diff the Postgres
snapshots — which already exist — and `MERGE` only what changed. The snapshots
were designed with this in mind.

**2. Scan wall-clock, across many regions.** 6 services × 30 regions is 180
units at a concurrency of 6. Because per-bucket S3 calls are four API calls
each, an account with 10,000 buckets is 40,000 calls in one unit.

Partly addressed: the Resource Explorer fast path asks one indexed query which
regions actually hold resources and skips the rest, so an account with 30
enabled regions and resources in four scans 4 regions rather than 30. It cannot
do more than that — a search result carries an ARN, type and region, not the
security group rules or bucket policies every question here depends on, so the
detailed Describe calls still happen. It is also unavailable on any account
without an aggregator index, which a read-only role cannot create, and it cannot
be exercised against the mock at all. _Remaining fix:_ per-service concurrency
rather than one global limit, and splitting oversized units.

**3. Throttling, well before that.** `retryMode: adaptive` handles bursts, but
a full parallel scan of a busy account will hit service quotas — and worse,
compete with the customer's own workloads. _Fix:_ a token bucket per
`(service, region)` sized from published quotas, and a scan budget the customer
controls.

**4. The frontend, at about 2,000 nodes.** React Flow renders every node; dagre
layout is O(V+E) but the DOM is not. Already mitigated by filtering noisy kinds
by default. _Fix:_ server-side aggregation — collapse a VPC to one node until
expanded — and viewport virtualisation.

**5. The agent's context, on broad questions.** Tool results are capped at 12k
characters and truncated. On a large account "list all EC2 instances" is
useless anyway. _Fix:_ tools should return aggregates with drill-down rather
than rows, and say so when truncating.

**What does not break:** partial failure handling and credential renewal both
get _more_ useful at scale, which is why they were built in from the start
rather than added later.

**Multi-tenancy** is the other axis. Today a single module-level flag tracks
whether a scan is running, and the graph holds one account. Multi-tenant needs
an account id on every node and query, per-tenant credential caching, and a job
queue instead of an in-process scan. The storage model already carries
`accountId` on every resource; the scan orchestration is what would change.

## What I would build next

1. **Incremental graph updates.** The highest-value change: it removes the
   first scaling limit and makes scans cheap enough to run continuously rather
   than on demand.
2. **Real idle detection.** Current idle findings use structural signals only —
   attached to nothing, associated with nothing, stopped. CloudWatch metrics
   and Cost Explorer would turn "this volume is unattached" into "this instance
   has been under 2% CPU for thirty days", which is a much more useful finding.
   The role already grants the permissions.
3. **An LLM judge over a larger eval set.** Closes the gap named above, and
   makes prompt changes safe to make quickly.
4. **Scheduled scans, so change detection runs without being asked.** Diffing
   exists, the agent can query it and the **Changes** tab surfaces it — but
   every scan is still triggered by a human, so "what changed overnight?" is
   only answerable if somebody remembered to scan last night. A scheduled scan
   plus a digest of what materially changed is what makes this a product
   someone opens daily rather than one they remember to use.
5. **More of the account.** ELB, ECS, EKS, API Gateway, CloudFront and
   Route 53. The collector interface is deliberately small — each is an
   afternoon — and load balancers in particular would fill a real gap in the
   reachability graph.
6. **NACLs, peering and Transit Gateway in the reachability model.** Today the
   analysis is conservative: it can miss a path, but a path it reports is
   justified by rules that really exist. Peering and Transit Gateway are the
   biggest honest gaps.

---
