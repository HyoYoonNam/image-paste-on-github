mock_provider "google" {
  mock_data "google_project" {
    defaults = { number = "123456789012" }
  }
}

variables {
  project_id = "demo-image-paste-auth"
}

run "bootstrap_is_private" {
  command = plan

  assert {
    condition     = length(google_cloud_run_v2_service.relay) == 0 && length(google_cloud_run_v2_service_iam_member.public) == 0
    error_message = "Bootstrap must not deploy a service or grant anonymous access."
  }
  assert {
    condition     = output.callback_url == "https://image-paste-auth-123456789012.asia-northeast3.run.app/auth/callback"
    error_message = "App registration and runtime must share the deterministic callback URL."
  }
  assert {
    condition     = google_project_iam_member.firestore.condition[0].expression == "resource.name == 'projects/demo-image-paste-auth/databases/image-paste-auth'"
    error_message = "Firestore IAM must be restricted to the named authentication database."
  }
  assert {
    condition     = google_secret_manager_secret_iam_member.relay.role == "roles/secretmanager.secretAccessor" && google_secret_manager_secret_iam_member.relay.secret_id == google_secret_manager_secret.github.secret_id
    error_message = "Secret access must target only the App's client secret."
  }
  assert {
    condition     = toset(keys(google_firestore_field.expiry)) == toset(["image_paste_auth_transactions", "image_paste_auth_states"]) && alltrue([for field in google_firestore_field.expiry : field.field == "expireAt" && length(field.ttl_config) == 1 && length(field.index_config[0].indexes) == 0])
    error_message = "Both state collections need Timestamp TTL with no query indexes."
  }
  assert {
    condition     = alltrue([for field in google_firestore_field.no_indexes : field.field == "*" && length(field.index_config[0].indexes) == 0])
    error_message = "Authorization codes and proofs must not be indexed for queries."
  }
  assert {
    condition     = google_logging_project_exclusion.requests.filter == "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"image-paste-auth\" AND log_id(\"run.googleapis.com/requests\")"
    error_message = "Exclude this service's request URLs, preserving other services and container logs."
  }
}

run "private_service_uses_managed_credentials" {
  command = apply
  variables {
    deploy_service        = true
    image                 = "asia-northeast3-docker.pkg.dev/demo-image-paste-auth/image-paste-auth/relay@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    github_client_id      = "Iv1.testclient"
    github_app_slug       = "image-paste-auth-test"
    github_secret_version = "2"
  }
  assert {
    condition     = length(google_cloud_run_v2_service_iam_member.public) == 0
    error_message = "Deploying a service must not implicitly enable public access."
  }
  assert {
    condition     = google_cloud_run_v2_service.relay[0].template[0].service_account == google_service_account.relay.email
    error_message = "The container must use the dedicated runtime service account."
  }
  assert {
    condition     = { for env in google_cloud_run_v2_service.relay[0].template[0].containers[0].env : env.name => env.value if env.name != "GITHUB_CLIENT_SECRET" } == local.runtime_env && local.runtime_env.SESSION_STORE == "firestore" && local.runtime_env.FIRESTORE_DATABASE_ID == "image-paste-auth"
    error_message = "Every revision must share the same Firestore database and collection prefix."
  }
  assert {
    condition     = one([for env in google_cloud_run_v2_service.relay[0].template[0].containers[0].env : env.value_source[0].secret_key_ref[0].version if env.name == "GITHUB_CLIENT_SECRET"]) == "2"
    error_message = "The client secret must be a pinned Secret Manager version, never a plaintext environment value."
  }
  assert {
    condition     = google_cloud_run_v2_service.relay[0].scaling[0].min_instance_count == 0 && google_cloud_run_v2_service.relay[0].scaling[0].max_instance_count == 3 && google_cloud_run_v2_service.relay[0].template[0].containers[0].ports[0].container_port == 8080
    error_message = "The service must use the Cloud Run port contract and bounded scaling configuration."
  }
}

run "public_access_is_explicit" {
  command = apply
  variables {
    deploy_service        = true
    public_access         = true
    image                 = "asia-northeast3-docker.pkg.dev/demo-image-paste-auth/image-paste-auth/relay@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    github_client_id      = "Iv1.testclient"
    github_app_slug       = "image-paste-auth-test"
    github_secret_version = "2"
  }
  assert {
    condition     = one(google_cloud_run_v2_service_iam_member.public).member == "allUsers" && one(google_cloud_run_v2_service_iam_member.public).role == "roles/run.invoker"
    error_message = "Only the explicit public step should allow GitHub callbacks and native clients."
  }
}

run "reject_mutable_image" {
  command = plan
  variables {
    deploy_service        = true
    image                 = "example/relay:latest"
    github_client_id      = "Iv1.testclient"
    github_app_slug       = "image-paste-auth-test"
    github_secret_version = "2"
  }
  expect_failures = [google_cloud_run_v2_service.relay]
}

run "reject_latest_secret" {
  command = plan
  variables {
    deploy_service        = true
    image                 = "example/relay@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    github_client_id      = "Iv1.testclient"
    github_app_slug       = "image-paste-auth-test"
    github_secret_version = "latest"
  }
  expect_failures = [google_cloud_run_v2_service.relay]
}

run "reject_missing_app_registration" {
  command = plan
  variables {
    deploy_service        = true
    image                 = "example/relay@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    github_secret_version = "2"
  }
  expect_failures = [google_cloud_run_v2_service.relay]
}

run "reject_collection_path" {
  command = plan
  variables { collection_prefix = "other/database" }
  expect_failures = [var.collection_prefix]
}
