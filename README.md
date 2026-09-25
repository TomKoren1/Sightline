# dave.io Engineering Home Assignment

Welcome, and thanks for taking the time. This document is the full brief.

## About dave.io

dave.io is an **AI-native DevOps service** company. We embed a real human DevOps engineer (in your timezone and language) alongside **Dave**, our proprietary AI system that plugs into a customer's infrastructure and SDLC and executes tasks at machine speed. Customers get the judgment of a senior engineer with the throughput of a system that never sleeps.

## What this assignment is

We'd like you to build a thin slice of a real product feature — something we can actually run, click around, talk to, and reason about with you.

The feature has three equal parts, and we care about all three:

1. **Infra**: connect to a customer's AWS account safely and understand what's in it.
2. **Data**: ingest those resources and their relationships into a store that suits the data.
3. **AI**: put an agent on top that answers real questions about the account, grounded in what you ingested.

There's a little boilerplate in this repository: a `docker-compose.yml` with two databases and an IAM role template. Use what helps you, replace what doesn't. How you structure the project is up to you. We haven't pinned a backend framework, frontend framework, LLM provider, or agent framework: pick the stack you'd actually reach for.

## The problem

A new dave.io customer wants Dave to manage their AWS environment. Before Dave can act, the customer (and their assigned human DevOps engineer) needs to **see and understand what's actually in the account**, and be able to **ask questions about it in plain language**.

### Part 1: Connect and ingest

1. **Connect** to an AWS account using the read-only IAM role defined in [`infra/readonly-role.yaml`](./infra/readonly-role.yaml). That file describes how dave.io gets access in production. You can modify it, work around it, or replace it with something better.
2. **Discover and ingest** the customer's AWS resources. Pick a representative set, such as EC2, S3, IAM, VPC, RDS and Lambda; you don't need every service. The AWS SDK is the obvious starting point. AWS Resource Explorer (for example `aws resource-explorer-2 list-resources`) is also worth a look for pulling a bulk inventory across services and regions in a few calls.
3. **Store** the resources and their relationships somewhere sensible. We've put both **Neo4j** and **Postgres** in `docker-compose.yml`. Use either, both, or neither, whatever fits the shape of the data and the questions the agent will need to answer.

### Part 2: The agent

4. **Build an agent** that answers questions about the ingested account. For example:
   - "Which S3 buckets are public?"
   - "What can reach the production RDS instance?"
   - "Which EC2 instances aren't in a private subnet?"
   - "Which IAM roles have admin access, and what uses them?"
   - "What changed since the last scan?"
   - "Is anything here costing money but not being used?"

   A DevOps engineer should be able to trust its answers enough to act on them. How you get there is up to you. The one hard rule: the agent must never change anything in the customer's account.

   Any model and any agent framework is fine. If you want a suggestion, try LangChain's [Deep Agents](https://github.com/langchain-ai/deepagents), but it's not required.

### Part 3: Show it to the user

5. **Visualize** the resource graph in a frontend using a graph layout library such as React Flow / xyflow. Keep it simple; this part doesn't need polish.
6. **Chat with the agent** in the same UI. It helps if resources the agent mentions can be found or highlighted in the graph.
7. **Communicate state** throughout: scan progress, data freshness, the ability to refresh, empty states, partial-failure states, and what the agent is doing while it works.

A single-account, single-tenant version is the target. If you want to gesture at multi-tenancy, scale, cost or production robustness as you build, great — it's a bonus, not a requirement.

## What's already in the box

```
.
├── README.md                       <- this file
├── docker-compose.yml              <- Neo4j + Postgres, ready to `docker compose up`
├── .env.example                    <- env vars referenced by compose
└── infra/
    └── readonly-role.yaml          <- how dave.io accesses the customer account
```

## Getting started

```bash
cp .env.example .env
docker compose up -d

# Neo4j browser:  http://localhost:7474   (user: neo4j, password: see .env)
# Postgres:       localhost:5432          (db/user/password: see .env)
```

Then bring up your own backend and frontend, point them at the env vars in `.env`, and start building. You'll need an API key for whichever LLM provider you choose; tell us in your README how to supply it.

## Deliverables

One thing we need: **a runnable project**. We should be able to clone, follow your README, and see the feature work end-to-end: scan an account, view the graph, and ask the agent questions. You can run it against a real AWS account or a mocked AWS layer, your call. If you mock it, make the mock data interesting enough that the agent's questions have non-obvious answers.

In your README, include a short **design note** covering:

- Why you chose your storage model, and how it serves the agent's questions.
- How the agent works, and why you built it that way.
- How you know the agent's answers are right, and how you'd know if a change made it worse.
- What breaks first on a large account (thousands of resources, many regions), and what you'd do about it.
- What you'd build next if you had another week.

Optionally, a short walkthrough video (Loom or similar) where you show the thing running and talk us through the choices you made. Not required at all — but some candidates find it the easiest way to communicate the parts that don't show up in code.

## Definition of done

A sanity check, not a checklist to game:

- Someone can clone the repo, follow your README, and get the feature running.
- The seven items in "The problem" are addressed, in code or in a short note explaining why you skipped them.
- The agent answers the example questions, or ones like them, correctly.
- The frontend handles the obvious UX states (loading, empty, stale, partial failure, error, agent thinking) in some recognizable way.
- The integration model in `infra/readonly-role.yaml` is accommodated, or you've replaced it with something you like better.

## How we'll evaluate

We're a small team, so we read submissions carefully and talk about them together. We weigh infra, coding and AI roughly equally. A few things we tend to notice:

- **Infra judgment.** Do you understand the AWS access model, least privilege, and what "read-only" really means? Do you handle rate limits, pagination, multiple regions and partial failures?
- **Code quality.** Is the code clear, sensibly structured, and something a teammate could pick up?
- **AI engineering.** Does the agent's design hold up beyond a demo, on real questions and on accounts that aren't tiny? Can we trust what it says?
- **UX.** Does it make sense to a real user? Does it tell them what's happening, what's stale, what failed, and what the agent is doing?
- **Production thinking.** Would you defend these decisions in production, not just on a take-home? Does the running thing actually do what your README says?
- **The brief itself.** Tell us anything you noticed that we got wrong, missed, or could have asked better.

We're not grading on visual polish, framework name-dropping, or lines of code. Build the thing you'd build for a real customer. If you run out of time, a smaller thing that works well and is honestly documented beats a bigger thing that half works.

## Ground rules

Plan for about 3–5 days of work. Use AI tools as much as you like — we do. Be creative. Build something a real user would actually want to use.

## Submission

Send a link (Drive / Dropbox / GitHub) to gal@dave.io with the subject line **"dave.io Engineering Assignment — Tom"**.

We'll respond within 5 business days with next steps.

Good luck — we're looking forward to seeing what you build.

— The dave.io team
