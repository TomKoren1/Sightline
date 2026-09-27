terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  # No remote backend, matching the sibling project: state is a local,
  # gitignored .tfstate file. Fine for a handful of resources applied from one
  # machine; the first thing to change if a second person ever applies this.
}
