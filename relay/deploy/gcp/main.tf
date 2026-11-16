data "google_project" "current" {
  project_id = var.project_id
}

locals {
  public_base_url = "https://${var.service_name}-${data.google_project.current.number}.${var.region}.run.app"
  collections     = toset(["${var.collection_prefix}_transactions", "${var.collection_prefix}_states"])
  runtime_env = {
    HOST                        = "0.0.0.0"
    PUBLIC_BASE_URL             = local.public_base_url
    GITHUB_CLIENT_ID            = var.github_client_id
    GITHUB_APP_SLUG             = var.github_app_slug
    SESSION_STORE               = "firestore"
    FIRESTORE_PROJECT_ID        = var.project_id
    FIRESTORE_DATABASE_ID       = google_firestore_database.auth.name
    FIRESTORE_COLLECTION_PREFIX = var.collection_prefix
  }
}

resource "google_project_service" "apis" {
  for_each = toset([
    "artifactregistry.googleapis.com", "firestore.googleapis.com",
    "iam.googleapis.com", "logging.googleapis.com", "run.googleapis.com",
    "secretmanager.googleapis.com"
  ])
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "relay" {
  project       = var.project_id
  location      = var.region
  repository_id = var.service_name
  format        = "DOCKER"
  depends_on    = [google_project_service.apis]
}

resource "google_service_account" "relay" {
  project      = var.project_id
  account_id   = var.service_name
  display_name = "Image Paste authentication relay"
  depends_on   = [google_project_service.apis]
}

resource "google_firestore_database" "auth" {
  project                 = var.project_id
  name                    = var.database_id
  location_id             = var.region
  type                    = "FIRESTORE_NATIVE"
  delete_protection_state = "DELETE_PROTECTION_ENABLED"
  deletion_policy         = "PREVENT"
  depends_on              = [google_project_service.apis]
}

resource "google_project_iam_member" "firestore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.relay.email}"
  condition {
    title       = "only-relay-database"
    description = "The relay can access only its named authentication database."
    expression  = "resource.name == 'projects/${var.project_id}/databases/${google_firestore_database.auth.name}'"
  }
}

# Only document ID lookups are used, so fields need no query indexes.
resource "google_firestore_field" "no_indexes" {
  for_each   = local.collections
  project    = var.project_id
  database   = google_firestore_database.auth.name
  collection = each.value
  field      = "*"
  index_config {}
}

resource "google_firestore_field" "expiry" {
  for_each   = local.collections
  project    = var.project_id
  database   = google_firestore_database.auth.name
  collection = each.value
  field      = "expireAt"
  ttl_config {}
  index_config {}
}

resource "google_secret_manager_secret" "github" {
  project   = var.project_id
  secret_id = "${var.service_name}-github-client-secret"
  replication {
    auto {}
  }
  lifecycle {
    prevent_destroy = true
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_iam_member" "relay" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.github.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.relay.email}"
}

# Cloud Run requestUrl includes the OAuth callback query. This affects _Default
# only; operators must also check custom and ancestor sinks before public access.
resource "google_logging_project_exclusion" "requests" {
  project     = var.project_id
  name        = "${var.service_name}-request-urls"
  description = "Do not retain relay request URLs, which can contain OAuth codes."
  filter      = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${var.service_name}\" AND log_id(\"run.googleapis.com/requests\")"
  depends_on  = [google_project_service.apis]
}

resource "google_cloud_run_v2_service" "relay" {
  count               = var.deploy_service ? 1 : 0
  project             = var.project_id
  name                = var.service_name
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = true

  scaling {
    min_instance_count = 0
    max_instance_count = var.max_instances
  }

  template {
    service_account                  = google_service_account.relay.email
    timeout                          = "30s"
    max_instance_request_concurrency = 16
    containers {
      image = var.image
      ports {
        container_port = 8080
      }
      resources {
        limits   = { cpu = "1", memory = "256Mi" }
        cpu_idle = true
      }
      dynamic "env" {
        for_each = local.runtime_env
        content {
          name  = env.key
          value = env.value
        }
      }
      env {
        name = "GITHUB_CLIENT_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.github.secret_id
            version = var.github_secret_version
          }
        }
      }
      startup_probe {
        http_get { path = "/health" }
        period_seconds    = 5
        timeout_seconds   = 2
        failure_threshold = 12
      }
    }
  }

  lifecycle {
    precondition {
      condition     = can(regex("^[^[:space:]]+@sha256:[a-f0-9]{64}$", var.image))
      error_message = "Deploy a pushed container by its immutable sha256 digest."
    }
    precondition {
      condition     = can(regex("^[1-9][0-9]*$", var.github_secret_version))
      error_message = "Add the client secret outside Terraform and supply its numeric version."
    }
    precondition {
      condition     = can(regex("^[A-Za-z0-9_.-]+$", var.github_client_id)) && can(regex("^[a-z0-9-]+$", var.github_app_slug))
      error_message = "Set the registered GitHub App client ID and slug."
    }
  }

  depends_on = [
    google_project_iam_member.firestore,
    google_secret_manager_secret_iam_member.relay,
    google_firestore_field.expiry,
    google_firestore_field.no_indexes,
    google_logging_project_exclusion.requests
  ]
}

resource "google_cloud_run_v2_service_iam_member" "public" {
  count    = var.deploy_service && var.public_access ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.relay[0].name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
