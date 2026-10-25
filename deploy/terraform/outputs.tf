# The values the cluster's sightline-app secret carries, so they are read from
# here rather than copied from the console.

output "aws_kms_key_id" {
  description = "AWS_KMS_KEY_ID"
  value       = aws_kms_key.tenant_secrets.arn
}

output "scanner_principal_arn" {
  description = "SCANNER_PRINCIPAL_ARN - every customer's trust policy names it"
  value       = aws_iam_user.scanner.arn
}

output "role_template_url" {
  description = "ROLE_TEMPLATE_URL"
  value       = "https://${aws_s3_bucket.templates.bucket_regional_domain_name}/${aws_s3_object.readonly_role_v1.key}"
}
