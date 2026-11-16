# GitHub 로그인 설계

GitHub App의 브라우저 OAuth와 PKCE를 사용한다. 플러그인은 인증을 시작하고 사용자 토큰을 보관하며, Cloudflare Worker가 GitHub의 코드 교환과 토큰 갱신을 중계한다. D1은 로그인 대기 상태를 공유한다. 운영 환경과 로컬 workerd 테스트에서 같은 구현을 사용하며, 이미지는 플러그인에서 GitHub로 직접 업로드한다.

이 문서는 프로토콜과 검증 기준을 설명한다. 실제 GitHub App 등록, 도메인 배포, 데스크톱과 모바일의 로그인 검증 여부는 별도로 확인해야 한다.

## 신뢰 경계

- `client_secret`은 Worker의 암호화된 secret binding에만 둔다. 플러그인 번들, 설정, 브라우저 URL에 포함하지 않는다. App private key는 사용하지 않는다.
- 서버는 토큰 교환과 갱신 과정에서 사용자 토큰을 일시적으로 처리하지만, 데이터베이스나 파일에 저장하지 않는다. 이미지, 노트 내용도 받지 않는다.
- D1은 로그인 대기 상태와 authorization code를 저장한다. 원본 OAuth state 대신 SHA-256 해시를 색인으로 사용하고, PKCE verifier와 사용자 토큰은 저장하지 않는다. 코드는 완료 요청이 선점되면 현재 데이터에서 제거한다. D1 Free의 Time Travel 복구본에는 이전 상태가 최대 7일 동안 남을 수 있다.
- Obsidian의 `SecretStorage`가 있으면 OAuth 세션을 보관한다. 이 API가 없는 이전 버전은 메모리에서만 세션을 유지하고, 앱을 다시 열면 로그인한다. OAuth 토큰을 `data.json`에 저장하는 대체 경로는 두지 않는다.
- 기존 PAT 설정은 고급 설정에 유지한다. GitHub 로그인 실패 시 PAT로 자동 전환하지 않는다. PAT를 선택한 경우 기존 평문 저장 방식이 적용된다.
- OAuth 세션은 토큰을 발급한 relay 주소에 묶는다. 다른 서버로 주소를 바꾸기 전에 연결을 해제해야 하며, 기존 refresh token을 새 주소로 전송하지 않는다.
- 공개 배포는 HTTPS를 사용한다. 개발용 HTTP는 명시적으로 허용한 loopback 주소에서만 사용한다.

## API 계약

JSON 요청과 응답은 UTF-8을 사용한다. POST 요청은 `Content-Type: application/json`이 필요하고, 모든 응답에 `Cache-Control: no-store`를 적용한다. 토큰과 verifier는 본문으로만 전달한다. GitHub callback의 일회용 code와 OAuth state는 query로 들어오지만 Obsidian 복귀 링크에는 포함하지 않는다.

| 요청 | 입력 | 성공 응답 또는 동작 |
| --- | --- | --- |
| `GET /health` | 없음 | `{ "status": "ok" }` |
| `GET /auth/config` | 없음 | `{ clientId, appSlug, installationUrl, callbackUrl }` |
| `POST /auth/start` | `{ codeChallenge, clientState }` | `{ transactionId, authorizationUrl, expiresAt }` |
| `GET /auth/callback` | GitHub의 `state`, `code` 또는 `error` | 검증 후 고정된 Obsidian 복귀 링크 제공 |
| `POST /auth/complete` | `{ transactionId, codeVerifier }` | 아래의 토큰 응답 |
| `POST /auth/cancel` | `{ transactionId, codeVerifier }` | 검증 후 대기 상태 삭제, `204` |
| `POST /auth/refresh` | `{ refreshToken }` | 새 토큰 응답 |
| `POST /auth/revoke` | `{ accessToken }` | GitHub 회수 성공 또는 이미 없는 토큰이면 `204` |

`expiresAt`은 Unix epoch 기준 밀리초다. 토큰 응답은 GitHub와 같은 snake_case 필드인 `access_token`, `refresh_token`, `expires_in`, `refresh_token_expires_in`, `token_type`을 사용한다. `expires_in`과 `refresh_token_expires_in`의 단위는 초다. 서버와 플러그인 모두 필요한 필드와 유효한 만료 값을 확인한다.

`clientState`는 32바이트 난수를 43자의 base64url로 표현한다. `codeVerifier`는 암호학적 난수로 만든 43~128자의 RFC 7636 unreserved 문자열이며, `codeChallenge`는 verifier의 SHA-256 결과를 43자의 base64url로 표현한 값이다. 플러그인은 완료나 취소까지 원본 verifier를 메모리에 보관한다.

토큰 응답은 다음 필드만 포함한다. 예시의 고정 시간을 가정하지 않고 실제 응답의 유효기간을 사용한다.

```json
{
  "access_token": "USER_ACCESS_TOKEN",
  "token_type": "bearer",
  "expires_in": 28800,
  "refresh_token": "REFRESH_TOKEN",
  "refresh_token_expires_in": 15897600
}
```

오류는 `{ "error": "stable_code", "message": "static message" }` 형식이다. GitHub나 D1의 원문 오류와 요청 값은 메시지에 반사하지 않는다.

| 상태 | 오류 코드 | 처리 |
| --- | --- | --- |
| `400` | `invalid_request`, `user_denied` | 입력을 확인하거나 로그인을 다시 시작한다. |
| `403` | `invalid_proof`, `origin_not_allowed` | 요청을 거절하며 잘못된 proof로 로그인을 소비하지 않는다. |
| `404` | `transaction_not_found`, `not_found` | 만료, 취소된 로그인 또는 없는 경로다. |
| `409` | `authorization_pending` | 브라우저 승인을 마친 뒤 완료를 다시 요청할 수 있다. |
| `409` | `transaction_consumed` | 이미 처리한 로그인이다. 다시 로그인한다. |
| `413` | `body_too_large` | 요청 본문 제한을 초과했다. |
| `429` | `rate_limited` | `Retry-After` 이후 다시 시도한다. |
| `502` | `github_error` | GitHub 교환이나 회수를 완료하지 못했다. |
| `503` | `unavailable` | 인증 비활성, 저장소 장애, D1 한도 초과 또는 선점 시간 초과다. |

## 로그인 순서

1. 플러그인은 암호학적 난수로 PKCE verifier와 `clientState`를 만든다. `S256` challenge를 계산하고, 원본 vault의 메모리에 verifier와 대기 상태를 둔다.
2. `/auth/start`는 각각 32바이트 난수로 `transactionId`와 GitHub용 OAuth `state`를 생성한다. D1에는 transaction ID, state 해시, challenge, `clientState`, 만료 시각을 한 행으로 저장한다. GitHub 인증 URL에는 `code_challenge`, `code_challenge_method=S256`, OAuth `state`, 고정된 callback URL, `scope=offline_access`를 포함한다.
3. 사용자는 외부 브라우저에서 GitHub에 로그인하고 앱을 승인한다. 저장소 접근은 GitHub App 설치에서 선택한 저장소와 Contents 권한에 따른다. 사용자 승인과 저장소 설치는 별도 단계이므로, 승인만으로 업로드 권한이 생겼다고 판단하지 않는다. 플러그인은 쓰기 권한이 확인된 공개 저장소를 사용자가 선택한 뒤 업로드를 허용한다. 새 로그인에서 이전 PAT의 저장소를 자동 선택하지 않는다.
4. `/auth/callback`은 D1에 저장된 OAuth state 해시, 만료 시각, 처리 상태를 확인한다. 정상 코드 또는 거절 여부만 보관하고 오류 원문은 저장하지 않는다. 같은 트랜잭션의 callback을 다시 받아 코드를 덮어쓰지 않는다.
5. 브라우저에는 다음 형태의 고정 링크를 제공한다. 여기에 authorization code, verifier, 토큰, vault 이름을 넣지 않는다.

   ```text
   obsidian://image-paste-on-github-auth?transaction_id=...&state=...
   ```

6. 플러그인은 원본 vault의 대기 상태와 `transaction_id`, `state`가 일치할 때만 완료 요청을 보낸다. 다른 vault로 복귀한 경우 무시한다. 사용자는 원본 vault의 **Complete sign in** 버튼으로 같은 요청을 다시 시작할 수 있다. 이 버튼도 저장된 verifier를 사용한다.
7. `/auth/complete`는 verifier의 S256 값과 저장된 challenge를 비교한다. GitHub 승인이 아직 끝나지 않았으면 `409 authorization_pending`을 반환하고 대기 상태를 유지한다. 잘못된 verifier는 트랜잭션을 소비하지 않는다.
8. 정상 완료 요청은 GitHub 호출 전에 상태를 처리 중으로 바꾸고 저장된 code를 제거한다. 반환받은 code, 요청의 verifier, Worker의 `client_secret`, 고정 callback URL로 토큰을 교환한다. 성공한 토큰은 HTTPS 응답으로만 전달하고 로그인 행을 정리한다. 동시 완료 요청과 재사용은 거절한다.

GitHub의 PKCE 지원은 `client_secret` 요구를 없애지 않는다. 따라서 코드 교환은 서버에서 수행한다. GitHub 인증 URL과 설치 URL은 GitHub의 고정된 origin과 경로만 사용하며, callback 입력에서 임의 URL을 받아 열지 않는다.

## 만료, 취소, 재시도

D1의 같은 데이터베이스와 `APP_NAMESPACE`를 사용하는 Worker가 상태를 공유한다. 단일 테이블의 기본 키는 namespace와 transaction ID이고, OAuth state 해시에는 unique index를 둔다. callback과 취소의 상태 변경은 만료 시각, 기존 상태, 필요한 proof를 조건으로 한 SQL 한 번으로 처리한다.

완료 선점은 D1의 원자적 batch 안에서 기존 상태를 읽고 `consuming` 변경과 code 제거를 함께 수행한다. batch가 성공하고 실제 변경이 한 행인 경우에만 읽어 둔 code를 반환한다. 외부 GitHub 교환은 이 SQL 작업이 끝난 뒤 한 번만 실행하며, SQL 재시도나 복구 과정에서 수행하지 않는다. batch 응답을 잃었거나 10초 제한 시간이 지난 경우에는 교환하지 않는다.

D1 로그인은 10분 뒤 사용할 수 없고, 15분 Cron 하나가 expiry index를 사용해 최대 200행씩 정리한다. 삭제가 지연되어도 만료 검사를 통과할 수 없다. Time Travel에서 DB를 복구하면 이미 소비된 과거 상태가 돌아올 수 있으므로 인증을 비활성화한 상태에서 새 namespace로 전환한 뒤 다시 로그인하게 한다. `AUTH_ENABLED=false`는 health만 제공하고 모든 인증 요청을 거절한다.

같은 D1을 사용하면 callback과 완료 요청이 서로 다른 Worker에 도착해도 처리할 수 있다. 플러그인 자체가 재시작되어 로컬 verifier를 잃은 경우에는 다시 로그인해야 한다. 10분은 인증 유효기간이며 데이터의 물리 삭제 기한은 아니다. 완료와 취소는 로그인 행을 삭제하고, 중단된 로그인의 잔여 행은 Cron으로 정리한다. 교환 뒤 정리가 실패해도 이미 소비된 행을 되살리지 않으며, 저장소 장애는 원문을 노출하지 않는 `503 unavailable`로 처리한다.

완료 선점은 최대 10초 동안 기다린다. 제한 시간이 지나면 `503`을 반환하고, 뒤늦게 커밋이 성공해도 GitHub 교환을 시작하지 않는다. 선점이 끝나기 전에 클라이언트 연결 종료가 감지되면 교환을 건너뛰고 소비된 상태를 정리한다. Workers가 연결 종료를 전달하지 않는 경우까지 취소를 보장하지는 않는다.

취소 요청도 verifier로 소유를 확인한다. 로그아웃, 플러그인 종료, 새 로그인 시작 시 플러그인은 이전 대기 상태를 무효화한다. 늦게 도착한 callback이나 응답으로 취소한 세션을 복원하지 않는다.

교환 중 통신이 끊기면 GitHub에서 코드가 이미 소비되었는지 확정할 수 없다. 같은 코드를 자동으로 반복 교환하지 않고 로그인을 다시 시작한다. `authorization_pending`만 아직 진행 중인 상태로 취급한다. 사용자 거절, 만료, 잘못된 응답은 구분하되 GitHub의 원문 오류나 요청 값을 사용자 메시지에 그대로 출력하지 않는다.

## 갱신과 연결 해제

GitHub는 refresh token을 사용하면 이전 refresh token과 access token을 무효화한다. 플러그인은 동시에 여러 갱신을 시작하지 않고 하나의 진행 중인 요청을 공유한다. 새 access token과 refresh token은 한 쌍으로 교체한다.

갱신 응답을 받더라도 로그아웃이나 세션 변경이 먼저 발생했으면 이전 세션에 저장하지 않는다. 저장 작업 도중 인증이 취소된 경우에도 저장 완료 후 자격 증명을 지운다. 새로 발급받은 토큰을 저장하지 못했다면 원격 회수를 시도한다. 갱신 실패나 응답 손실로 토큰 상태가 불확실해진 경우 무한 재시도하지 않고 재로그인을 안내한다. 토큰은 발급 당시의 relay에만 보낸다.

업로드는 시작한 인증 세대를 기억한다. 이미지 읽기나 노트 확인을 기다리는 동안 로그아웃, 계정 변경, 인증 방식 변경이 발생하면 GitHub PUT 요청을 새로 시작하지 않는다. 최종 비동기 검사가 끝난 직후에도 같은 인증 상태인지 확인한다.

연결 해제는 로컬 세션을 지우고 진행 중인 인증을 무효화한다. 원격 회수에는 서버가 `DELETE /applications/{client_id}/token`을 사용한다. 사용자의 모든 기기에서 권한을 제거하는 `/grant` 삭제는 사용하지 않는다. 토큰 만료나 네트워크 오류로 원격 회수를 확인하지 못해도 로컬 연결은 해제하며, GitHub에서 앱 권한을 직접 해제할 수 있음을 안내한다. 로컬 삭제만으로 원격의 모든 토큰이 회수됐다고 표시하지 않는다.

## 서버 제한

- callback URL은 서버의 고정 공개 주소로 만든다. 요청의 `Host`, `X-Forwarded-Host`를 사용하지 않는다.
- GitHub 요청 대상과 client ID는 서버 설정으로 고정한다. 요청 본문에서 upstream 주소나 client secret을 받지 않으며, upstream redirect를 따라가지 않는다.
- 요청 본문은 16 KiB, GitHub 응답은 32 KiB, upstream 대기는 10초로 제한한다. 메모리 요청 제한은 Worker isolate별로 IP당 분당 120회, IP 항목 최대 10,000개, 동시 upstream 요청 32개다. D1에는 전역 로그인 수 제한을 두지 않는다. Cloudflare 계정은 Free를 유지하고 플랫폼 한도 초과 시 서비스 오류로 처리한다. 한도 초과를 해결하기 위한 자동 유료 전환은 하지 않는다.
- IP 제한에는 Cloudflare의 `CF-Connecting-IP`를 사용하고 `X-Forwarded-For`는 신뢰하지 않는다. 공개 클라이언트의 CORS나 Origin 검사는 인증을 대신하지 않는다.
- callback 페이지는 외부 스크립트와 리소스를 사용하지 않는다. 고정 링크의 값은 URL 인코딩과 HTML escaping을 적용하고, `no-store`, `Referrer-Policy: no-referrer`, 제한적인 CSP를 적용한다.
- 애플리케이션과 역방향 프록시는 callback query, 요청 본문, Authorization 헤더, 코드, 토큰을 로그에 남기지 않는다. 오류 응답은 정해진 코드와 문구로 제한한다.
- Cloudflare 배포는 Workers Logs, invocation logs, traces, issues, Logpush, tail consumer와 preview URL을 비활성화한다. 관리자가 나중에 live tail을 여는 것까지 이 설정이 막지는 않으므로 실제 인증 중에는 `wrangler tail`과 Dashboard 실시간 로그를 사용하지 않는다. secret은 Worker의 암호화된 secret binding으로 입력한다.

## 검증 기준

모의 GitHub를 사용하는 테스트는 정상 로그인 외에 잘못된 state와 verifier, callback 재사용, 동시 완료 요청, 만료, 취소, 승인 전 완료 요청, GitHub 거절, timeout과 잘못된 응답을 확인한다. callback HTML과 deep link에 code나 토큰이 없어야 하고, 처리된 code를 다시 교환할 수 없어야 한다.

Cloudflare 테스트는 실제 로컬 workerd와 D1에 migration을 적용하고 독립 Worker 또는 store의 완료 경쟁, 취소, SQL rollback, 응답 손실, 늦은 완료, namespace 분리, 만료 정리를 확인한다. GitHub 통신은 mock만 허용하며 redirect 목적지로 코드나 token이 전송되지 않아야 한다. 런타임의 fetch 동작과 필수 GitHub 헤더도 이 통합 테스트에서 확인한다.

플러그인 테스트는 다른 vault의 callback 무시, 수동 완료, 로그인 중 취소와 종료, 동시 갱신, 갱신 중 로그아웃, 토큰 저장 실패, relay 주소 변경, PAT로 자동 전환하지 않는 동작을 확인한다. [클라이언트 통합 테스트](../relay/cloudflare/test/auth-client.test.mjs)는 플러그인의 `GitHubAuth`를 실제 workerd와 D1에 연결해 PKCE 계산, callback HTML, 갱신, 연결 해제, 취소와 거절을 확인한다. 외부 GitHub 계정이나 secret은 사용하지 않는다.

Node.js 22.12 이상에서 루트의 `npm ci`와 `npm ci --prefix relay/cloudflare`로 설치한다. `npm test`는 플러그인 테스트, `npm run test:relay`와 `npm run test:cloudflare`는 같은 Cloudflare 테스트, `npm run test:browser`는 production bundle의 설정 UI와 HEIC 변환을 실행한다. 별도 서버나 에뮬레이터 프로세스를 준비하지 않는다.

실제 App과 배포 주소가 준비되면 외부 브라우저에서 승인 후 데스크톱과 모바일로 복귀하는지, 선택한 저장소에만 업로드하는지, 만료 토큰 갱신과 연결 해제가 동작하는지 별도로 확인한다.

## 공식 자료

- [GitHub App 사용자 토큰 발급과 PKCE](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [사용자 토큰 갱신과 rotation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)
- [GitHub App 보안 권장 사항](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app)
- [개별 토큰과 앱 권한 회수 API](https://docs.github.com/en/rest/apps/oauth-applications)
- [Obsidian URI](https://help.obsidian.md/uri)
