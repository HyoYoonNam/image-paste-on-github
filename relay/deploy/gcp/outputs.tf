output "public_base_url" {
  value = local.public_base_url
}

output "callback_url" {
  value = "${local.public_base_url}/auth/callback"
}

output "image_repository" {
  value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.relay.repository_id}/relay"
}

output "github_secret_id" {
  value = google_secret_manager_secret.github.secret_id
}

output "runtime_service_account" {
  value = google_service_account.relay.email
}
