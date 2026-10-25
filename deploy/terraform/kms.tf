# The key every tenant's ExternalId is encrypted under (apps/api/src/tenancy/secrets.ts).
# Losing it means every customer redeploys their stack, so it is never destroyed
# by a plan: deleting it is a decision made in the console, with its waiting period.
resource "aws_kms_key" "tenant_secrets" {
  description = "Sightline tenant secrets"

  # Off, and deliberately: each rotation adds a key version AWS bills for, and the
  # project runs at no running cost. Turning it on is one line and costs money.
  enable_key_rotation = false

  policy = jsonencode({
    Version = "2012-10-17"
    Id      = "key-default-1"
    Statement = [{
      Sid       = "Enable IAM User Permissions"
      Effect    = "Allow"
      Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }
      Action    = "kms:*"
      Resource  = "*"
    }]
  })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "tenant_secrets" {
  name          = "alias/sightline"
  target_key_id = aws_kms_key.tenant_secrets.key_id
}
