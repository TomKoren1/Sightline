# `infra/platform/`

The AWS side of the **hosted service**: the identity the API and worker pods
run as.

Not to be confused with [`../readonly-role.yaml`](../readonly-role.yaml), which
is the opposite end of the same handshake — the role a _customer_ creates in
_their_ account, and which this identity assumes.

## What it creates

One IAM user with exactly two permissions:

- **`kms:Encrypt` / `Decrypt` / `DescribeKey`** on the key that encrypts
  per-tenant secrets — an Anthropic API key, and the external id that
  authorises an AssumeRole into a customer's account. The key is **looked up,
  not created**: it reuses the one the sibling project provisioned, so
  Terraform never owns it and `destroy` here cannot delete a key holding
  another application's data.
- **`sts:AssumeRole`** on `arn:aws:iam::*:role/DaveIoReadOnlyRole`. The account
  is a wildcard because every customer has a different one; the role name is
  not, so a stolen credential cannot assume arbitrary roles it discovers.

Everything else this service can see in a customer's account is governed by
_their_ trust policy, not by anything here.

## Applying

```bash
cd infra/platform
cp terraform.tfvars.example terraform.tfvars   # defaults are usually right
terraform init
terraform apply
```

Then read the two secret outputs deliberately — they are marked `sensitive`, so
`apply` will not print them into a terminal, a CI log or a screenshot:

```bash
terraform output -raw platform_access_key_id
terraform output -raw platform_secret_access_key
```

Both go into the SealedSecret, never into `values.yaml` or a `.env` —
[`helm/daveio/README.md`](../../helm/daveio/README.md) has the `kubeseal`
command.

The non-secret output is the one customers need:

```bash
terraform output platform_user_arn
```

That is the principal they name in their CloudFormation stack, and what the
Connection panel shows a signed-in tenant.

## Why a long-lived access key

A bare k3s cluster has no IRSA and no instance role, so there is no
short-lived credential mechanism to use — the same conclusion the sibling
project reached. On EKS this would be a role assumed through a service
account, and `iam_platform_user.tf` would be three lines shorter.

The mitigation is scope rather than lifetime: two actions on one key, and
AssumeRole on one role name. Rotation is `terraform taint
aws_iam_access_key.platform && terraform apply`, then regenerating the
SealedSecret.

## One thing to check before applying

Hosted mode **refuses to start** if `AWS_ACCESS_KEY_ID` looks like a
placeholder rather than a real key, because a mock key sits first in the SDK's
credential chain and silently shadows the real identity. If the API logs
`AWS_ACCESS_KEY_ID does not look like a real AWS key`, the SealedSecret has a
leftover in it.
