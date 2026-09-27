variable "aws_region" {
  description = "Region for the KMS lookup. The IAM user itself is global."
  type        = string
  default     = "us-east-1"
}

variable "kms_alias" {
  description = <<-EOT
    Alias of the key that encrypts per-tenant secrets.

    Looked up rather than created: this reuses the key the sibling project
    already provisioned. Terraform therefore never owns it, and `destroy` here
    cannot delete a key holding another application's data.
  EOT
  type        = string
  default     = "alias/resume-builder-api-keys"
}

variable "scanner_role_name" {
  description = <<-EOT
    The role name customers create in their own account.

    Fixed by infra/readonly-role.yaml, and the reason the AssumeRole policy can
    be scoped at all: the account is a wildcard because every customer has a
    different one, but the role *name* is ours to specify. A customer who
    renames it cannot be scanned, which is the intended trade.
  EOT
  type        = string
  default     = "DaveIoReadOnlyRole"
}

variable "user_name" {
  description = "The IAM user the API and worker pods run as."
  type        = string
  default     = "daveio-platform"
}
