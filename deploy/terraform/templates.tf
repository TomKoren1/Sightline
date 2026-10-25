# Where customers' one-click CloudFormation links fetch the role from
# (ROLE_TEMPLATE_URL). Public by design: the template is the same for everyone
# and holds nothing secret - the ExternalId arrives as a parameter.
resource "aws_s3_bucket" "templates" {
  bucket = "sightline-templates-587f44"

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "templates" {
  bucket = aws_s3_bucket.templates.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "templates" {
  bucket = aws_s3_bucket.templates.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = false
  }
}

# Off, so the policy below can grant public read; the policy grants nothing else.
resource "aws_s3_bucket_public_access_block" "templates" {
  bucket                  = aws_s3_bucket.templates.id
  block_public_acls       = false
  ignore_public_acls      = false
  block_public_policy     = false
  restrict_public_buckets = false
}

resource "aws_s3_bucket_policy" "templates" {
  bucket     = aws_s3_bucket.templates.id
  depends_on = [aws_s3_bucket_public_access_block.templates]
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "PublicReadTemplates"
      Effect    = "Allow"
      Principal = "*"
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.templates.arn}/templates/*"
    }]
  })
}

# The published template, from the repository's copy, so the two cannot drift:
# the copy uploaded by hand on 2026-10-16 lacked the generated collector grants,
# organizations:ListAccounts, and still set NoEcho on the ExternalId - which
# quick-create links silently refuse to pre-fill.
resource "aws_s3_object" "readonly_role_v1" {
  bucket       = aws_s3_bucket.templates.id
  key          = "templates/v1/readonly-role.yaml"
  source       = "${path.module}/../../cloudformation/readonly-role.yaml"
  etag         = filemd5("${path.module}/../../cloudformation/readonly-role.yaml")
  content_type = "application/yaml"
}
