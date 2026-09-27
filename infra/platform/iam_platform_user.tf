# The identity the hosted service runs as.
#
# A dedicated IAM user with a long-lived access key, deliberately, and for the
# same reason the sibling project does it: a bare k3s cluster has no IRSA and
# no instance role, so there is no short-lived credential mechanism available.
# On EKS this would be a role assumed through a service account and this file
# would be three lines shorter.
#
# It has exactly two permissions. Everything else a customer's account exposes
# is reached by assuming *their* read-only role, with an external id, and is
# governed by their trust policy rather than by anything here.

data "aws_kms_alias" "tenant_secrets" {
  name = var.kms_alias
}

resource "aws_iam_user" "platform" {
  name = var.user_name

  tags = {
    Project     = "daveio"
    Description = "API and scan worker pods"
  }
}

resource "aws_iam_access_key" "platform" {
  user = aws_iam_user.platform.name
}

# 1. Decrypt the per-tenant secrets: an Anthropic API key, and the external id
#    that authorises an AssumeRole into a customer's account.
#
# `DescribeKey` is needed as well as Encrypt/Decrypt: the SDK calls it to
# resolve an alias to a key id, and without it every encrypt fails with an
# AccessDenied that names the alias rather than the missing permission.
resource "aws_iam_user_policy" "kms_tenant_secrets" {
  name = "daveio-kms-tenant-secrets"
  user = aws_iam_user.platform.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "EncryptDecryptTenantSecrets"
      Effect = "Allow"
      Action = [
        "kms:Encrypt",
        "kms:Decrypt",
        "kms:DescribeKey",
      ]
      # The key ARN behind the alias, not the alias ARN: an alias can be
      # repointed, and a policy that grants on the alias would follow it to
      # whatever key it names next.
      Resource = data.aws_kms_alias.tenant_secrets.target_key_arn
    }]
  })
}

# 2. Assume the read-only role customers create in their own accounts.
#
# The account is a wildcard because every customer has a different one; the
# role name is not, so a stolen credential cannot assume arbitrary roles it
# happens to discover. The external id is per tenant and enforced by the
# customer's own trust policy, which is the half of this that actually stops
# the confused-deputy attack - a resource wildcard here would still be useless
# without it.
resource "aws_iam_user_policy" "assume_scanner_roles" {
  name = "daveio-assume-scanner-roles"
  user = aws_iam_user.platform.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "AssumeCustomerScannerRole"
      Effect   = "Allow"
      Action   = "sts:AssumeRole"
      Resource = "arn:aws:iam::*:role/${var.scanner_role_name}"
    }]
  })
}
