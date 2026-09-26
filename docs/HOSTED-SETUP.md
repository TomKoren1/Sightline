# Hosted setup — what to create, where, and what to paste

Everything the hosted deployment needs from outside this repository, in the
order you will want it. Each section says **where to click**, **what you get**,
and **which variable it goes in**.

Nothing here is needed for the self-hosted project: `docs/HOSTED-PLAN.md`
explains the split, and the defaults in `.env.example` keep the demo working
untouched.

---

## 1. Google sign-in

Google is the only identity provider. No password ever reaches this service.

### Where

1. **<https://console.cloud.google.com/>** → create a project (or reuse one).
2. **APIs & Services → OAuth consent screen**
   - User type: **External**, unless the account is in a Workspace and only
     colleagues will sign in.
   - App name, support email, developer contact. That is all that is required.
   - Scopes: **add none**. This service asks for `openid` and `email`, both of
     which are non-sensitive and need no verification or review.
   - While the app is in **Testing**, only accounts listed under _Test users_
     can sign in — add your own address there first. Publishing is only needed
     when other people will use it, and with these two scopes it does not
     require Google's verification review.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type: **Web application**.
   - **Authorised redirect URIs** — add both, exactly:

     ```
     http://localhost:5173/auth/google/callback
     https://<your-hostname>/auth/google/callback
     ```

     The path is fixed by the code. Google matches these **character for
     character**: a missing `/auth`, an extra trailing slash, or `http` where
     you registered `https` all fail with `redirect_uri_mismatch`.

### What you get, and where it goes

| Google shows you                          | Variable               |
| ----------------------------------------- | ---------------------- |
| Client ID (`…apps.googleusercontent.com`) | `GOOGLE_CLIENT_ID`     |
| Client secret                             | `GOOGLE_CLIENT_SECRET` |

Plus the origin the browser reaches, which is **not** from Google — you choose
it, and it must match the redirect URI above:

```bash
PUBLIC_BASE_URL=http://localhost:5173     # local testing
PUBLIC_BASE_URL=https://<your-hostname>   # deployed
```

The redirect URI is built from `PUBLIC_BASE_URL` and never from the request's
`Host` header, deliberately: a forged header would otherwise be able to send an
authorization code somewhere else.

---

## 2. Session secret

Not from anyone — generate it:

```bash
openssl rand -base64 48
```

```bash
SESSION_SECRET=<that value>
```

Sessions are signed cookies rather than a server-side store, so several API
replicas need nothing shared **except this secret being identical on all of
them**. Changing it signs everyone out, which is also how you sign everyone out
on purpose.

---

## 3. KMS, for per-tenant secrets

You already have a key from the sibling project. Two things to check before
reusing it:

```bash
KMS_KEY_ID=<the key id or alias>
```

- **The pod's IAM identity needs `kms:Encrypt`, `kms:Decrypt` and
  `kms:DescribeKey` on it.** The resume-builder IAM user has that for its own
  key; if this service runs as a _different_ identity, its policy needs the
  same three actions on the same key ARN.
- **Blast radius.** One key encrypting two applications' secrets means one
  compromised identity reads both. A separate key costs about a dollar a month
  and is the cleaner answer — your call, and worth making deliberately rather
  than by reuse.

```bash
AWS_KMS_KEY_ID=<key id or alias/name>
```

Hosted mode **refuses to start** without it: a key sitting in an environment
variable is not good enough for other people's secrets (ADR-015).

---

## 4. The scanner's own AWS identity

The identity this service assumes customer roles _from_. On a bare cluster
there is no IRSA, so this is an IAM user with an access key, exactly as the
sibling project does it.

**Where:** IAM → Users → create user → no console access → attach an inline
policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AssumeCustomerScannerRoles",
      "Effect": "Allow",
      "Action": "sts:AssumeRole",
      "Resource": "arn:aws:iam::*:role/DaveIoReadOnlyRole"
    },
    {
      "Sid": "TenantSecrets",
      "Effect": "Allow",
      "Action": ["kms:Encrypt", "kms:Decrypt", "kms:DescribeKey"],
      "Resource": "<the KMS key ARN>"
    }
  ]
}
```

The `Resource` on the first statement is scoped to the **role name the
customer template creates**, so a stolen credential cannot assume arbitrary
roles it happens to discover. Customers who rename the role cannot connect —
which is the intended trade.

Its access key goes into a SealedSecret for the pod, **not** into `.env`:
hosted mode refuses to start with `AWS_ACCESS_KEY_ID` in the environment.

---

## 5. Cloudflare Tunnel

**Where:** <https://one.dash.cloudflare.com/> → **Networks → Tunnels → Create a
tunnel** → **Cloudflared** → name it → **Save**.

- The token is on the "Install and run a connector" screen, inside the sample
  command (`cloudflared service install <TOKEN>`). Copy the token itself.
- Then **Public Hostname → Add a public hostname**: choose the subdomain,
  select your domain, and point it at the in-cluster service, e.g.
  `http://dave-web.default.svc.cluster.local:80`.

The token goes into a SealedSecret, as `TUNNEL_TOKEN`, read from the
environment by `cloudflared tunnel run` — the same shape as the sibling
project's `cloudflared-sealedsecret.yaml`.

No inbound port is ever opened: the connector dials out.

---

## 6. Testing sign-in locally, before any of the cluster exists

Only sections 1 and 2 are needed for this.

```bash
# .env
DEPLOYMENT_MODE=hosted
AWS_MODE=real
AWS_ENDPOINT_URL=
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
SESSION_SECRET=<openssl rand -base64 48>
GOOGLE_CLIENT_ID=<...>
GOOGLE_CLIENT_SECRET=<...>
PUBLIC_BASE_URL=http://localhost:5173
SECRETS_LOCAL_KEY=<any long random string>   # stands in for KMS locally
```

```bash
npm run dev:api
npm run dev:web      # open http://localhost:5173
```

The blank `AWS_*` lines matter: hosted mode refuses to start with an endpoint
override or static keys configured, and a blank value is how you say "unset" —
deleting the line lets `.env.example`'s default come back instead.

You should see the sign-in screen, land back on the app after choosing an
account, and find a new tenant with no scans. `docs/HOSTED-PLAN.md` covers what
is still missing (the worker, the connection UI, the chart).

### If sign-in fails

| What you see                          | Almost always                                                                                                                                                                                                                          |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `redirect_uri_mismatch`               | The URI in Google does not match `PUBLIC_BASE_URL` + `/auth/google/callback` exactly — scheme, port and trailing slash included                                                                                                        |
| `Sign-in is not configured: …`        | That variable is missing; the message names it                                                                                                                                                                                         |
| `access_blocked` / "app not verified" | Your address is not in _Test users_ on the consent screen                                                                                                                                                                              |
| Signs in, immediately signed out      | `SESSION_SECRET` differs between restarts, or `Secure` cookie over plain http — hosted mode sets `Secure`, so use https or test with `DEPLOYMENT_MODE=hosted` behind the Vite proxy on localhost, which is treated as a secure context |
