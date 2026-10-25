# OpenTofu or Terraform: the configuration uses nothing either lacks. 1.10 for
# the S3 backend's native lock file, so no DynamoDB table is needed for locking.
terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # Patch releases only; 6.68 was 18 days old when pinned, the newest was 3.
      version = "~> 6.68.0"
    }
  }

  # The bucket is given at init (README.md), so this file names no account.
  backend "s3" {
    key          = "sightline/platform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = "us-east-1"

  default_tags {
    tags = {
      Project   = "sightline"
      ManagedBy = "terraform"
      Source    = "github.com/TomKoren1/Sightline/deploy/terraform"
    }
  }
}

data "aws_caller_identity" "current" {}
