# Privacy

Sightline reads the configuration of an AWS account you connect and shows you
what is in it. This describes what that means for your data, in the order you
would actually want to know it.

Written plainly and specifically on purpose. A privacy policy that could
describe any service describes none, and this one has to be checkable against
[`SECURITY.md`](SECURITY.md) and against the code.

## What Sightline holds

**Your AWS inventory.** Resource names, ARNs, regions, tags, and configuration:
security group rules, IAM policy documents, bucket policies and public-access
settings, instance types, RDS settings, Lambda configuration. Enough to answer
"what is reachable from the internet" and "which role is effectively an
administrator".

**Your account identifier.** The twelve-digit AWS account id, and the ARN of the
role you created. The account id is not a secret — every ARN contains it — but
it identifies you, so it stays out of URLs.

**A shared secret.** The ExternalId, which is half of what lets Sightline assume
your role. Stored encrypted; see [`SECURITY.md`](SECURITY.md#the-externalid).

**Who you are, as your identity provider tells us.** Your email address, name
and avatar URL from Google or GitHub, and the provider's stable identifier for
you. No password: Sightline never sees one.

**What you asked the assistant.** Your questions, its answers, which tools it
called and which ARNs it cited — kept so a conversation can be re-read, and so a
wrong answer can be investigated rather than argued about.

## What Sightline does not hold

**The contents of anything.** Not objects in your buckets, not rows in your
databases, not parameter or secret values. This is not a policy choice that
could be quietly reversed: the role you deploy carries an explicit **Deny** on
data-plane reads, and an explicit Deny in AWS cannot be overridden by any Allow
— including one a future AWS update adds to a managed policy. Sightline could
not read your data if it tried.

**Any long-lived credential of yours.** Access is `sts:AssumeRole` into the role
you created, and the resulting session is held in memory and expires. There is
no access key of yours anywhere in the system.

**Anything about you from anywhere else.** No analytics, no third-party
trackers, no advertising identifiers, no profile built from other sources.

## Who it is shared with

Nobody, with three exceptions that are all mechanical rather than commercial:

| Who                  | What reaches them                                                   | Why                     |
| -------------------- | ------------------------------------------------------------------- | ----------------------- |
| **AWS**              | the API calls that read your account                                | that is the product     |
| **Google or GitHub** | that you signed in                                                  | you chose that provider |
| **Anthropic**        | the question you asked, and the inventory facts needed to answer it | the assistant           |
| **Cloudflare**       | every request, in transit                                           | it carries the traffic  |

The assistant is the one worth being specific about. When you ask it a question,
the relevant parts of your inventory — resource names, ARNs, relationships — are
sent to Anthropic's API as context. Not your whole account, and nothing it did
not need, but it is a real transfer of real information about your
infrastructure to a third party. **If you would rather that never happened, do
not use the assistant**; the graph, the findings and the scan history work
without it. In a self-hosted deployment it uses your own API key and the choice
is entirely yours.

Cloudflare is how the hosted service is reached: a tunnel from Cloudflare's
network to Sightline's server, so the encrypted connection from your browser
ends at Cloudflare's edge and continues to Sightline through the tunnel.
Cloudflare handles each request on its way through; it does not hold your
inventory.

Your data is not sold, rented, or used to train anything.

## Where it is held

In one place: Sightline's own database, on a server Sightline operates rather
than a cloud provider's managed database. Backups are encrypted, and are kept
only on that server and on other machines Sightline owns. Nothing is replicated
anywhere else. ExternalIds are encrypted with a key held in AWS KMS,
so decrypting one needs both that database and Sightline's AWS account.

What leaves it: a question's context to Anthropic, as above, and nothing else.
Scans read your account through AWS's regional APIs and the results come back
to that one database; nothing is written into your account.

## How long it is kept

Scan history accumulates, because comparing two scans is the point — "what
changed since last week" needs last week. Each scan's resource snapshots are
immutable. The most recent 30 scans of each account are kept; older ones are
deleted after each new scan.

The graph keeps the current scan and the one before it. Older ones are swept.

## Deleting it

`DELETE /api/me` from the application, confirmed by typing your own email
address. It removes your graph, every scan and snapshot, every conversation,
every connection and every encrypted ExternalId, and your user record. It is
immediate and irreversible, and it reports what it deleted rather than returning
quietly.

Two honest caveats:

- **Sightline cannot delete the CloudFormation stack in your AWS account.** Only
  you can. Until you do, the role it created still exists and still trusts
  Sightline's principal — although with your ExternalId deleted, that trust
  cannot be used. Delete the stack.
- **An encrypted backup may still contain your data for up to 30 days.** Nightly
  dumps rotate out after that. Promising otherwise would mean either having no
  backups or lying about them.

Disconnecting a single account rather than deleting everything: use the
connection's own disconnect, which purges that account's graph and scan history
and tells you to delete its stack.

## Security

In [`SECURITY.md`](SECURITY.md), with more detail than belongs here: what is
encrypted and how, how one customer's data is kept from another's, what the
assistant is prevented from doing, and the known limitations.

## This is a personal project

It is run by one person, on one machine, with no company behind it and no
support commitment. That is not a disclaimer buried at the bottom — it is
something to weigh before connecting a production account. There is no SLA, no
uptime guarantee, and no second node.

To report a security problem, open a
[security advisory](https://github.com/TomKoren1/Sightline/security/advisories/new).
For anything else, open an issue.
