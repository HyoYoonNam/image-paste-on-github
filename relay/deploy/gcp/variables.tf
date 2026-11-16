variable "project_id" {
  description = "Existing GCP project with billing enabled."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "Use a GCP project ID, not its display name or number."
  }
}

variable "region" {
  type    = string
  default = "asia-northeast3"
}

variable "service_name" {
  type    = string
  default = "image-paste-auth"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.service_name))
    error_message = "Use 6-30 lowercase letters, digits or hyphens, starting with a letter and ending in a letter or digit."
  }
}

variable "database_id" {
  type    = string
  default = "image-paste-auth"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,61}[a-z0-9]$", var.database_id))
    error_message = "Use a dedicated named Firestore database (4-63 characters)."
  }
}

variable "collection_prefix" {
  type    = string
  default = "image_paste_auth"
  validation {
    condition     = can(regex("^[A-Za-z][A-Za-z0-9_]{0,63}$", var.collection_prefix))
    error_message = "Use a 1-64 character collection prefix, starting with a letter."
  }
}

variable "deploy_service" {
  description = "Enable after bootstrap, App registration, secret version creation and image push."
  type        = bool
  default     = false
}

variable "public_access" {
  description = "Enable after checking log exclusions with a harmless marker request. Required for GitHub and Obsidian."
  type        = bool
  default     = false
}

variable "image" {
  description = "Immutable container reference ending in @sha256:<64 hex characters>."
  type        = string
  default     = ""
}

variable "github_client_id" {
  type    = string
  default = ""
}

variable "github_app_slug" {
  type    = string
  default = ""
}

variable "github_secret_version" {
  description = "Numeric Secret Manager version. Secret content is never passed to Terraform."
  type        = string
  default     = ""
}

variable "max_instances" {
  type    = number
  default = 3
  validation {
    condition     = var.max_instances >= 1 && var.max_instances <= 100 && floor(var.max_instances) == var.max_instances
    error_message = "Use an integer from 1 to 100. This is not a spending cap."
  }
}
