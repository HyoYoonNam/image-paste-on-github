# Cloudflare Workers Free와 D1 Free 배포

GitHub App 인증을 Workers와 D1에서 처리한다. 이미지는 Obsidian에서 GitHub로 직접 전송하며 이 Worker를 통과하지 않는다. 기존 Node/Firestore relay와 같은 PKCE 계약을 사용한다.

계정은 **Workers Free**로 유지한다. 이 구성은 유료 플랜 전환, 카드 등록, 추가 유료 제품을 요구하지 않는다. 무료 한도를 넘으면 서비스가 실패할 수 있으므로 유료 전환으로 해결하지 않고 사용량부터 확인한다. `usage_model`은 지정하지 않는다. [Workers 요금](https://developers.cloudflare.com/workers/platform/pricing/), [D1 요금](https://developers.cloudflare.com/d1/platform/pricing/)

## 운영 인스턴스

기본 relay는 `https://image-paste-auth.dev-rudevico.workers.dev`, 공개 App은 [Image Paste on GitHub](https://github.com/apps/image-paste-on-github)다. 플러그인을 빌드하면 이 origin이 기본값에 들어가며 기존 사용자 설정은 보존한다.

2026-11-16에 Workers Free 계정으로 배포했다. D1 migration, 15분 Cron, 로그와 preview 비활성 설정을 적용했다. 실제 배포에서 health 200, 로그인 시작 200, 승인 전 완료 409, 취소 204, 취소 후 완료 404를 확인했다. macOS의 Obsidian 1.12.7에서 브라우저 로그인과 복귀, 저장소 선택, 샘플 PNG 업로드가 성공했고 로컬 이미지 첨부는 생기지 않았다.

별도 검증 로그인으로 access token과 refresh token 교체, 갱신 후 저장소 조회 200, revoke 204, 폐기한 토큰의 GitHub 응답 401도 확인했다. 이 검증의 토큰은 메모리에서만 처리했다. 모바일 복귀와 장기 운영 부하는 아직 확인하지 않았다.

## 로컬 검증

Node.js 22.12 이상을 사용하고 이 디렉터리에서 실행한다.

```sh
npm ci
npm test
npm run migrate:local
npm run build
```

Wrangler 4.162.0과 같은 workerd를 쓰는 Miniflare 5.20261113.0-beta를 정확한 버전으로 고정했다. 테스트는 실제 로컬 workerd와 D1을 사용하고 GitHub는 모의 응답으로 대체한다. `build`는 `wrangler deploy --dry-run`이므로 업로드하지 않는다. `migrate:local`은 로컬 데이터베이스에만 적용한다. [D1 로컬 개발](https://developers.cloudflare.com/d1/best-practices/local-development/)

GitHub 요청은 고정 `User-Agent`를 포함하고 redirect를 따라가지 않는다. 런타임 테스트는 필수 헤더 누락으로 인한 연결 해제 실패와 redirect를 통한 자격 증명 전달을 확인한다. [GitHub REST 헤더](https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api#user-agent)

## 1. 무료 계정과 D1 준비

Cloudflare Dashboard에서 Workers Free 사용 여부를 확인한 후 로그인한다. 아래부터는 실제 리소스를 생성하는 운영 명령이다.

```sh
npx wrangler login --use-keyring --scopes account:read user:read workers_scripts:write d1:write
npx wrangler d1 create image-paste-auth
cp wrangler.jsonc wrangler.local.jsonc
```

브라우저 승인 뒤 localhost callback에 연결하지 못하면 같은 명령에 `--device`를 추가한다. CLI가 표시한 기기 코드를 공식 Cloudflare 화면에 입력하면 localhost 없이 인증한다. `--use-keyring`은 자격 증명을 OS 키체인으로 보호한다. 이 배포에는 Wrangler의 모든 기본 권한이 필요하지 않다.

`wrangler.local.jsonc`는 Git에서 제외된다. 생성된 D1 `database_id`를 해당 파일에만 넣고 필요한 경우 `account_id`도 여기에서 설정한다. Worker 이름과 Dashboard의 workers.dev 하위 도메인으로 `PUBLIC_BASE_URL`을 정한다. 예: `https://image-paste-auth.YOUR-SUBDOMAIN.workers.dev`.

`AUTH_ENABLED="false"`와 로그 비활성 설정을 유지한다. `GITHUB_CLIENT_SECRET`은 이 파일이나 `.dev.vars`, 환경 파일, 명령행 인자에 넣지 않는다.

```sh
npx wrangler d1 migrations apply DB --remote --config wrangler.local.jsonc
npm run deploy
```

커밋된 `wrangler.jsonc`의 D1 UUID는 로컬 검증용 자리 표시자다. 이를 실제 배포에 사용하지 않는다. Workers의 기본 공개 주소만 사용하며 Preview URLs는 비활성화한다.

첫 업로드 직후 subdomain 조회에서 `10007`이 나면 Dashboard와 `wrangler deployments list --config wrangler.local.jsonc`에서 Worker와 버전이 생성됐는지 확인한다. 이미 생성됐다면 잠시 후 같은 설정으로 재배포하고 공개 주소와 Cron을 확인한다. 첫 실제 배포에서는 추가 권한 없이 재배포로 해결됐으며, 생성 직후 전파 지연으로 추정된다.

## 2. 로그 설정과 GitHub App 등록

배포한 Worker의 Dashboard에서 Workers Logs, invocation logs, traces, issues, Logpush, Tail Worker 연결이 모두 꺼져 있는지 확인한다. 운영 중 `wrangler tail`이나 Dashboard의 실시간 로그 화면을 열지 않는다. 설정 파일은 관리자가 나중에 실시간 tail을 여는 행위까지 막지는 않는다. 외부 로그 수집 도구도 연결하지 않는다. [Wrangler 설정](https://developers.cloudflare.com/workers/wrangler/configuration/)

`/health`가 200을 반환하고 `/auth/start`는 503을 반환하는지 확인한다. 로그 검증용 query를 붙인 `/health?log_probe=...`는 404가 정상이다. 실제 OAuth code나 token으로 로그 설정을 시험하지 않는다.

기존 [GitHub App 등록 절차](../README.md#register-the-github-app)에 따라 App을 등록한다. 커뮤니티 사용자도 설치할 수 있도록 **Any account**를 선택하고, 권한은 Contents read and write만 부여한다. Callback URL은 `${PUBLIC_BASE_URL}/auth/callback`, 사용자 토큰 만료는 활성화, 설치 중 자동 OAuth와 Webhooks는 비활성화한다.

Client ID와 App slug는 `wrangler.local.jsonc`의 공개 설정에 넣는다. 사용자가 Cloudflare Dashboard의 Worker 설정에서 암호화된 secret **`GITHUB_CLIENT_SECRET`**을 직접 입력한다. secret 값은 로컬 파일이나 저장소로 옮기지 않는다. 이후 배포에서도 secret binding이 유지되는지 이름만 확인한다.

GitHub가 설치 전에 private key 생성을 요구하면 App 소유자가 생성해 안전하게 보관한다. 이 relay는 사용자 OAuth만 사용하므로 private key를 배포하거나 읽지 않는다.

## 3. 인증 활성화와 확인

`AUTH_ENABLED="true"`로 바꿔 배포한다.

```sh
npm run deploy
```

먼저 `/auth/config`의 공개 metadata와 callback 주소를 확인한다. 임의의 테스트 PKCE 값으로 `start → 승인 전 complete(409) → cancel(204)`를 호출해 실제 D1 읽기와 쓰기를 확인한다. 이 검증에는 실제 GitHub 승인이 필요 없다.

GitHub App을 전용 공개 이미지 저장소에만 설치하고, 최신 플러그인의 **Advanced settings → Authentication relay**에 공개 origin을 넣는다. 브라우저 로그인, Obsidian 복귀, 저장소 선택, 합성 이미지 업로드, 토큰 갱신, 연결 해제를 확인한다. 로컬 테스트는 실제 계정 권한이나 모바일 복귀를 증명하지 않는다.

## 저장, 만료와 운영 한계

- D1 binding은 `DB`, 환경 구분 값은 `APP_NAMESPACE`다. 같은 App의 모든 배포는 같은 데이터베이스, namespace, GitHub App, 공개 origin을 사용한다. App이나 환경이 달라지면 별도 namespace를 사용한다. namespace는 SQL 범위 구분이며 계정 관리자에 대한 보안 격리는 아니다.
- 로그인은 10분 뒤 사용할 수 없다. 한 개의 15분 Cron이 만료 행을 최대 200개씩 정리한다. 처리량이 적체되면 정리가 더 늦어질 수 있지만 만료된 로그인은 다시 사용할 수 없다.
- access token, refresh token, PKCE verifier, client secret, 이미지와 원문 OAuth state는 D1에 저장하지 않는다. 브라우저 승인 후 authorization code는 완료 선점 때 제거된다. 선점 응답이 불확실하면 GitHub 교환을 시작하지 않고 재로그인을 요구한다.
- D1 Time Travel은 항상 켜져 있으며 Free에서는 최대 7일 전 상태를 복원할 수 있다. 행 삭제가 과거 복구본의 즉시 삭제를 의미하지 않는다. 인증 DB를 복구할 때는 `AUTH_ENABLED=false`로 두고 새 `APP_NAMESPACE`로 전환한 뒤 새 로그인을 시작한다. [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- 계정별 Workers 요청, CPU, D1 읽기와 쓰기 한도는 별개다. 이 Worker의 메모리 rate limit은 isolate별이므로 전역 사용량 제한이나 비용 보장으로 설명하지 않는다. SQL 인덱스와 제한된 cleanup으로 한 번의 작업량을 줄였지만 실제 Free CPU 한도는 배포 후 확인해야 한다. [Workers 제한](https://developers.cloudflare.com/workers/platform/limits/)

실제 계정 ID, 데이터베이스 ID, secret, 인증 응답, `.wrangler` 상태와 배포 산출물은 커밋하지 않는다. 배포를 멈출 때는 먼저 `AUTH_ENABLED=false`로 바꾸고, Cron까지 제거하려면 `triggers.crons=[]`를 명시해 다시 배포한다.
