terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

locals {
  all_bucket_names        = [for k, v in var.buckets : v.name]
  protected_bucket_names  = [for k, v in var.buckets : v.name if v.type == "protected"]
  public_bucket_names     = [for k, v in var.buckets : v.name if v.type == "public"]
  ingest_module_tag       = {"cumulus_module": "ingest"}
  archive_module_tag      = {"cumulus_module": "archive"}
  distribution_module_tag = {"cumulus_module": "distribution"}
}

resource "aws_s3_bucket_object" "buckets_json" {
  bucket  = var.system_bucket
  key     = "${var.prefix}/buckets/buckets.json"
  content = jsonencode(var.buckets)
  etag    = md5(jsonencode(var.buckets))
}
