output "platform_user_arn" {
  description = <<-EOT
    The principal customers name in their CloudFormation stack.

    This is what goes in the template's DaveIoScannerRoleArn parameter, and
    what the Connection panel shows a signed-in tenant. Not a secret.
  EOT
  value       = aws_iam_user.platform.arn
}

output "kms_key_arn" {
  description = "The key the pods encrypt tenant secrets with. Not a secret."
  value       = data.aws_kms_alias.tenant_secrets.target_key_arn
}

# The two values that go into the SealedSecret. Marked sensitive so a plain
# `terraform apply` does not print them into a terminal, a CI log or a
# screenshot; read them deliberately with `terraform output -raw`.
output "platform_access_key_id" {
  value     = aws_iam_access_key.platform.id
  sensitive = true
}

output "platform_secret_access_key" {
  value     = aws_iam_access_key.platform.secret
  sensitive = true
}
