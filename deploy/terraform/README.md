# The platform's AWS resources

What Sightline itself runs on in AWS, as code. The customer side - the
read-only role - is CloudFormation (`cloudformation/readonly-role.yaml`),
deployed in each customer's account; this is the other side of that handshake.

| Resource                               | Why it exists                                                                 |
| -------------------------------------- | ----------------------------------------------------------------------------- |
| KMS key `alias/sightline`              | Encrypts every tenant's ExternalId. Losing it means every customer redeploys. |
| IAM user `SightlineScanner`            | The worker's identity, named in every customer's trust policy.                |
| IAM user `sightline-kms`               | The API's identity: encrypt and decrypt, nothing else.                        |
| S3 bucket `sightline-templates-587f44` | Serves the role template to customers' one-click CloudFormation links.        |
| The template object                    | Published from `cloudformation/readonly-role.yaml`, so the two cannot drift.  |

**Deliberately not here:**

- **Access keys.** A key Terraform creates has its secret in the state, which
  would make the state a credential. Keys are created and rotated by hand, then
  sealed into the cluster ([`deploy/k8s/README.md`](../k8s/README.md)).
- **The cluster.** k3s on one machine, with everything on it reconciled by
  ArgoCD from `argocd/` and `deploy/k8s/`. That is already declarative; the
  only by-hand step is `kubectl apply -f` of the Applications.
- **Google sign-in, the Anthropic key, Cloudflare.** Accounts at other
  providers, configured in their consoles.
- **The `SightlineReadOnlyRole` roles in this account.** Those are the customer
  side, deployed by CloudFormation for scanning this account itself.

## Running it

OpenTofu (free and open source) or Terraform 1.10 or later. Credentials are the
standard AWS chain, for an identity that can manage the resources above.

```bash
cd deploy/terraform
tofu init -backend-config="bucket=<state bucket>"
tofu plan          # read it, every time
tofu apply
```

The state lives in S3 with S3's own lock file, so no DynamoDB table. The bucket
is passed at init rather than written here. Use a bucket you already have with
this file's `sightline/` key prefix, or create one for this project alone.

**The first apply** adopts what exists through `imports.tf`, and its plan is
`12 to import, 0 to add, 5 to change, 0 to destroy`:

- the four tags-only changes add `Project`, `ManagedBy` and `Source`;
- the fifth **republishes the role template**, which was uploaded by hand on
  2026-10-16 and has fallen behind the repository: no generated collector
  grants, no `organizations:ListAccounts`, and `NoEcho` on the ExternalId,
  which stops quick-create links pre-filling it. New stacks get the current
  template; stacks already deployed keep theirs until their owners update them.

`prevent_destroy` guards the key, the scanner user and the bucket. Removing any
of them is a decision for the console, not a side effect of a plan.

## The values the cluster needs

```bash
tofu output
```

`aws_kms_key_id`, `scanner_principal_arn` and `role_template_url` are the
`AWS_KMS_KEY_ID`, `SCANNER_PRINCIPAL_ARN` and `ROLE_TEMPLATE_URL` in the
`sightline-app` secret.
