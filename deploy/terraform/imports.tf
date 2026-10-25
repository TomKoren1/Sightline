# Everything here existed before this configuration did, made by hand. These
# blocks adopt it on the first apply; after that they are no-ops, and can stay as
# the record of where each resource came from.

import {
  to = aws_kms_key.tenant_secrets
  id = "4ebcfca1-f6b2-436d-ad79-cd7234dc921d"
}

import {
  to = aws_kms_alias.tenant_secrets
  id = "alias/sightline"
}

import {
  to = aws_iam_user.scanner
  id = "SightlineScanner"
}

import {
  to = aws_iam_user_policy.scanner
  id = "SightlineScanner:sightline-scanner"
}

import {
  to = aws_iam_user.kms
  id = "sightline-kms"
}

import {
  to = aws_iam_user_policy.kms
  id = "sightline-kms:sightline-kms-only"
}

import {
  to = aws_s3_bucket.templates
  id = "sightline-templates-587f44"
}

import {
  to = aws_s3_bucket_ownership_controls.templates
  id = "sightline-templates-587f44"
}

import {
  to = aws_s3_bucket_server_side_encryption_configuration.templates
  id = "sightline-templates-587f44"
}

import {
  to = aws_s3_bucket_public_access_block.templates
  id = "sightline-templates-587f44"
}

import {
  to = aws_s3_bucket_policy.templates
  id = "sightline-templates-587f44"
}

import {
  to = aws_s3_object.readonly_role_v1
  id = "sightline-templates-587f44/templates/v1/readonly-role.yaml"
}
