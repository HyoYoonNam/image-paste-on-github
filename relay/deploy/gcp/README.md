# GCP에 인증 중계 서버 배포하기

Cloud Run, Firestore Native, Secret Manager, Artifact Registry를 Terraform으로 구성한다. GitHub App 등록과 client secret 입력은 운영자가 진행한다. 이 설정을 저장소에 추가하는 것만으로 GCP 리소스가 만들어지거나 브라우저 로그인이 활성화되지는 않는다.

이미지는 계속 플러그인에서 GitHub로 직접 업로드한다. Firestore에는 10분 동안 유효한 로그인 대기 상태와 authorization code를 임시 저장한다. 사용자 access token, refresh token, PKCE verifier는 저장하지 않는다. 자세한 저장 정책은 [relay README](../../README.md)를 참고한다.

## 비용 조건

이 구성은 과금 가능성이 없는 무료 배포용이 아니다. 이름 있는 Firestore 데이터베이스는 무료 할당량을 적용받지 않으며, TTL 삭제도 무료 사용 대상이 아니다. Cloud Run의 일반 Free Tier는 결제 계정이 필요하고 무료 한도 초과분은 과금된다. 인스턴스 수 제한만으로 비용이 0원임을 보장할 수 없다. [Firestore 요금](https://cloud.google.com/firestore/pricing?hl=en), [Google Cloud Free Tier](https://docs.cloud.google.com/free/docs/free-cloud-features)

결제 계정 없이 한도에서 사용이 중단되는 Starter Tier는 별도 상품이다. 현재 또는 과거 유료 Cloud Billing 이력이 없는 개인 계정 등 자격 조건이 있으며, Google이 관리하는 프로젝트 하나를 사용한다. IAM, API, 서비스 설정이 제한되므로 이 Terraform을 그대로 적용하는 대상이 아니다. 과금 가능성을 허용하지 않는 경우 일반 결제 계정을 연결하거나 이 구성을 적용하지 않는다. [Starter Tier 조건과 제약](https://docs.cloud.google.com/docs/starter-tier)

## 준비

- 결제가 연결된 기존 GCP 프로젝트, 해당 프로젝트의 리소스 생성과 IAM 변경 권한
- Terraform 1.7 이상, Google Cloud CLI, Docker, 저장소 checkout
- Terraform을 실행할 계정의 Application Default Credentials

아래 명령은 별도 표시가 없으면 저장소 루트에서 실행한다. `terraform.tfvars`와 Terraform state는 Git에서 제외된다. 여러 사람이 운영할 때는 접근을 제한한 원격 backend를 별도로 구성한다. 이 모듈은 비밀값을 state에 넣지 않지만 state에는 인프라 식별자와 권한 설정이 들어간다.

```sh
gcloud auth login
gcloud auth application-default login
cp relay/deploy/gcp/terraform.tfvars.example relay/deploy/gcp/terraform.tfvars
```

`terraform.tfvars`의 `project_id`와 `region`을 수정한다. 기본 region은 서울 `asia-northeast3`이며 Firestore와 Cloud Run에 함께 적용된다. 데이터베이스 위치는 생성 후 변경하기 어려우므로 첫 적용 전에 정한다. 프로젝트를 새로 생성하거나 결제를 연결하는 작업은 이 모듈에 포함하지 않는다.

## 1. 인프라와 callback 주소 준비

기본값인 `deploy_service=false`, `public_access=false`로 먼저 적용한다.

```sh
terraform -chdir=relay/deploy/gcp init
terraform -chdir=relay/deploy/gcp plan
terraform -chdir=relay/deploy/gcp apply
terraform -chdir=relay/deploy/gcp output
```

이 단계에서는 API 활성화, 이미지 저장소, 전용 서비스 계정, 별도 Firestore 데이터베이스, TTL 정책, Secret Manager의 빈 secret, 요청 로그 제외 설정을 만든다. Cloud Run 서비스와 secret 내용은 아직 만들지 않는다. 기존 `(default)` Firestore 데이터베이스나 기존 IAM binding 전체를 덮어쓰지 않는다. 같은 이름의 리소스가 이미 있다면 새 이름을 사용하거나 검토 후 Terraform으로 import한다.

`callback_url` 출력값을 [GitHub App 등록 절차](../../README.md#register-the-github-app)의 callback URL로 사용한다. 별도 도메인 없이 Cloud Run의 [예측 가능한 HTTPS 주소](https://docs.cloud.google.com/run/docs/triggering/https-request#deterministic_url)를 사용한다. GitHub App의 client ID와 slug를 `terraform.tfvars`에 입력한다.

Google Cloud Console의 Secret Manager에서 `github_secret_id` 출력값에 해당하는 secret을 열고 새 버전에 GitHub App client secret을 입력한다. **secret 자체를 Terraform 변수, 저장소, 명령행 인자, 플러그인에 넣지 않는다.** 생성된 숫자 버전, 예를 들어 `1`만 `github_secret_version`에 적는다. `latest`는 허용하지 않는다.

## 2. 컨테이너 업로드

Docker가 실행 중이어야 한다. 사용하는 Google 계정에는 해당 Artifact Registry 저장소에 이미지를 업로드할 권한이 필요하다.

```sh
IMAGE_REPOSITORY="$(terraform -chdir=relay/deploy/gcp output -raw image_repository)"
REGISTRY_HOST="${IMAGE_REPOSITORY%%/*}"
IMAGE_TAG="${IMAGE_REPOSITORY}:$(git rev-parse --short HEAD)"
gcloud auth configure-docker "$REGISTRY_HOST"
docker build --platform linux/amd64 --tag "$IMAGE_TAG" ./relay
docker push "$IMAGE_TAG"
docker image inspect "$IMAGE_TAG" --format '{{index .RepoDigests 0}}'
```

마지막 출력인 `.../relay@sha256:...` 전체를 `terraform.tfvars`의 `image`에 넣는다. 변경 가능한 tag 대신 digest를 고정하므로 같은 설정을 다시 적용할 때 이미지가 바뀌지 않는다. `.env`, 배포용 tfvars, Terraform state는 이미지에 복사하지 않는다.

## 3. 비공개 서비스 검증

`deploy_service=true`로 바꾸고 `public_access=false`를 유지한다. App 정보, 이미지 digest, secret의 숫자 버전이 모두 있어야 계획 검증을 통과한다.

```sh
terraform -chdir=relay/deploy/gcp plan
terraform -chdir=relay/deploy/gcp apply
```

이 단계의 서비스는 Cloud Run IAM 인증을 요구한다. 테스트할 Google 계정에는 해당 서비스의 `roles/run.invoker` 권한이 있어야 한다. 프로젝트 정책상 필요하면 운영자가 이 계정에만 권한을 부여한다. 서비스를 공개하기 전에 비밀값이 없는 health 요청으로 실행과 로그 설정을 확인한다.

```sh
RELAY_URL="$(terraform -chdir=relay/deploy/gcp output -raw public_base_url)"
curl --fail --show-error \
  -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
  "${RELAY_URL}/health"
```

`{"status":"ok"}`를 확인한다. 이 health 응답은 프로세스 실행만 확인하며 Firestore IAM이나 GitHub 인증 성공을 증명하지 않는다. `/auth/config`의 `callbackUrl`이 App 등록값과 일치하는지도 확인한다.

### 공개 전 요청 로그 확인

Cloud Run은 요청 URL의 query까지 포함한 request log를 자동 생성한다. 이 모듈은 해당 서비스의 `run.googleapis.com/requests` 로그를 `_Default` sink에서 제외하며, 이 제외 설정을 서비스보다 먼저 생성한다. 컨테이너 시작 로그와 다른 서비스 로그는 유지한다. [Cloud Run 로깅](https://docs.cloud.google.com/run/docs/logging), [요청 URL 필드](https://docs.cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry#HttpRequest)

제외 정책은 **로그 생성을 끄는 기능이 아니며, `_Default` 밖의 sink에는 적용되지 않는다.** 프로젝트의 custom sink와 조직, 폴더의 aggregated sink도 확인하고, 같은 서비스 요청 로그를 각 경로에서 제외해야 한다. 프록시나 오류 추적 도구가 있다면 URL query, Authorization 헤더, 요청과 응답 본문도 수집하지 않도록 설정한다. [로그 라우팅 구조](https://docs.cloud.google.com/logging/docs/routing/overview)

비밀값이 없는 marker 요청을 별도로 보낸다. query가 붙은 health 경로는 의도적으로 `404`를 반환하므로 이 요청에는 `--fail`을 붙이지 않는다.

```sh
curl --show-error -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
  "${RELAY_URL}/health?log_probe=image-paste-auth-check"
```

설정 전파와 로그 수집 지연을 고려해 marker 요청을 반복하고, 각 로그 저장소와 외부 전송 대상에서 `image-paste-auth-check`가 보관되지 않는지 확인한다. 단순히 Logs Explorer 한 곳에서 검색 결과가 없다는 것만으로 모든 sink가 제외됐다고 판단하지 않는다. 이전에 저장된 로그는 제외 정책으로 소급 삭제되지 않는다. 이 확인 중에는 실제 OAuth code나 token을 보내지 않는다.

## 4. 공개하고 플러그인 연결

로그 확인이 끝나면 `public_access=true`로 바꾸고 `terraform plan`, `terraform apply`를 실행한다. 이 단계는 해당 서비스에만 `allUsers`의 `roles/run.invoker`를 추가한다. GitHub callback과 Obsidian은 Google IAM 토큰을 보내지 않으므로 이 공개 접근이 필요하다. 조직 정책이 `allUsers`를 금지하면 정책 담당자와 배포 방식을 먼저 조정한다.

플러그인의 **Advanced settings → Authentication relay**에 `public_base_url` 출력값을 입력한다. 기본 주소를 포함한 플러그인을 빌드하려면 다음과 같이 실행한다.

```sh
IMAGE_PASTE_AUTH_RELAY_URL="$(terraform -chdir=relay/deploy/gcp output -raw public_base_url)" npm run build
```

실제 App으로 로그인하고, 선택한 공개 이미지 저장소만 표시되는지, 업로드, 토큰 갱신, 연결 해제가 동작하는지 확인한다. 데스크톱과 모바일의 Obsidian 복귀도 각각 확인한다. `/auth/start`나 `/auth/complete`에서 `503 unavailable`이 나오면 먼저 서비스 계정의 Firestore 권한, 프로젝트, 데이터베이스 설정을 확인한다. 진단을 위해 요청 본문이나 인증 값을 로그에 추가하지 않는다.

## 운영 설정

- Firestore 접근은 전용 서비스 계정의 `roles/datastore.user`를 지정 데이터베이스에 한정한 IAM condition으로 부여한다. 서버 SDK는 Security Rules가 아닌 IAM을 사용한다. collection prefix는 데이터 구분용이며 보안 격리 수단은 아니다. [데이터베이스별 IAM](https://firebase.google.com/docs/firestore/manage-databases#configure_per-database_access_permissions)
- secret 접근 권한은 App client secret 하나에만 부여한다. 서비스 계정 키 파일 없이 Cloud Run의 기본 자격 증명을 사용한다. secret을 회전할 때는 새 버전을 추가하고 숫자 버전을 수정해 새 revision을 배포한다. 검증 후 이전 버전을 비활성화한다. [Cloud Run secret 설정](https://docs.cloud.google.com/run/docs/configuring/services/secrets)
- 모든 revision은 같은 프로젝트, 데이터베이스, prefix, GitHub App, 공개 origin을 사용해야 한다. App이나 origin을 변경할 때는 새 prefix를 사용하고 기존 로그인은 다시 시작한다. 플러그인 재시작으로 verifier를 잃은 로그인은 Firestore만으로 복구할 수 없다.
- 두 collection의 `expireAt`에 TTL을 설정하고 query index를 끈다. TTL 삭제는 보통 만료 후 24시간 이내에 처리되지만 즉시 삭제를 보장하지 않는다. 서버는 TTL과 무관하게 10분 만료를 직접 검사한다. 임시 code 보관 기간을 불필요하게 늘리는 백업이나 PITR은 이 모듈에서 활성화하지 않는다. [Firestore TTL](https://docs.cloud.google.com/firestore/native/docs/ttl)
- 기본 최소 인스턴스는 0, 최대는 3, 요청 동시성은 인스턴스당 16이다. Cloud Run의 최대 인스턴스 설정은 비용 상한이 아니며 일시 초과도 가능하다. Firestore에는 전체 로그인 생성 수 제한이 없다. 예산 알림과 사용량을 모니터링하고, 필요하면 신뢰할 수 있는 ingress에서 전체 요청량을 제한한다. 기본 구성에는 Cloud Armor나 외부 load balancer가 포함되지 않는다.
- 서버의 socket IP 제한은 인스턴스별이며 Cloud Run 프록시 뒤에서는 여러 사용자가 한도를 공유할 수 있다. 공개 서비스의 사용자별 제한으로 간주하지 않는다. 검증되지 않은 `X-Forwarded-For`를 신뢰하도록 바꾸지 않는다.
- 데이터베이스와 Cloud Run 서비스에는 삭제 보호를 설정했고 secret에는 Terraform `prevent_destroy`를 적용했다. 제거할 때는 보호 설정과 보관 데이터, secret version을 검토한 뒤 명시적으로 해제한다. API는 destroy 시 자동 비활성화하지 않는다.

## 설정 테스트

```sh
terraform -chdir=relay/deploy/gcp init -backend=false
terraform -chdir=relay/deploy/gcp fmt -check -recursive
terraform -chdir=relay/deploy/gcp validate
terraform -chdir=relay/deploy/gcp test
```

테스트는 Google provider를 mock으로 대체한다. bootstrap, 비공개 배포, 명시적 공개, IAM 범위, TTL, 로그 제외, digest와 secret version 검증을 확인한다. `terraform test` 안의 apply도 mock으로만 실행되며 GCP 리소스를 생성하지 않는다. 실제 배포의 IAM 전파, 조직 정책, 요청 로그 제외, TLS, TTL 물리 삭제, GitHub 인증은 확인하지 않는다. 로그인 상태 공유는 별도의 [Firestore 에뮬레이터 테스트](../../README.md#verification)로 검증한다.
