# The two identities the cluster holds keys for, each allowed one thing.
#
# Their access keys are not managed here: a key created by Terraform has its
# secret in the state, and the state would then be a credential. Keys are made
# and rotated by hand and sealed into the cluster (deploy/k8s/README.md).

# The worker's identity: the principal every customer's trust policy names
# (SCANNER_PRINCIPAL_ARN), so renaming it breaks every connected account.
resource "aws_iam_user" "scanner" {
  name = "SightlineScanner"

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_iam_user_policy" "scanner" {
  name = "sightline-scanner"
  user = aws_iam_user.scanner.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # The customer-side role's fixed name (cloudformation/readonly-role.yaml),
        # with or without the suffix a StackSet adds. SetSourceIdentity because
        # every assume sends one and the role's trust policy requires it.
        Sid    = "AssumeCustomerReadOnlyRoles"
        Effect = "Allow"
        Action = ["sts:AssumeRole", "sts:SetSourceIdentity"]
        Resource = [
          "arn:aws:iam::*:role/SightlineReadOnlyRole",
          "arn:aws:iam::*:role/SightlineReadOnlyRole-*",
        ]
      },
      {
        Sid      = "ProtectExternalIds"
        Effect   = "Allow"
        Action   = ["kms:Encrypt", "kms:Decrypt"]
        Resource = aws_kms_key.tenant_secrets.arn
      },
    ]
  })
}

# The API's identity: it encrypts and decrypts ExternalIds and can assume nothing.
resource "aws_iam_user" "kms" {
  name = "sightline-kms"
}

resource "aws_iam_user_policy" "kms" {
  name = "sightline-kms-only"
  user = aws_iam_user.kms.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["kms:Encrypt", "kms:Decrypt"]
      Resource = aws_kms_key.tenant_secrets.arn
    }]
  })
}
