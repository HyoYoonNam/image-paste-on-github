# GitHub 로그인 설계

GitHub App의 브라우저 OAuth와 PKCE를 사용한다. 플러그인은 인증을 시작하고 사용자 토큰을 보관하며, 인증 중계 서버(relay)는 GitHub의 코드 교환과 토큰 갱신에 필요한 `client_secret`을 보관한다. 이미지는 플러그인에서 GitHub로 직접 업로드한다.

이 문서는 프로토콜과 검증 기준을 설명한다. 실제 GitHub App 등록, 도메인 배포, 데스크톱과 모바일의 로그인 검증 여부는 별도로 확인해야 한다.

## 신뢰 경계

- `client_secret`은 서버 환경 변수에만 둔다. 플러그인 번들, 설정, 브라우저 URL에 포함하지 않는다. App private key는 사용하지 않는다.
- 서버는 토큰 교환과 갱신 과정에서 사용자 토큰을 일시적으로 처리하지만, 데이터베이스나 파일에 저장하지 않는다. 이미지, 노트 내용도 받지 않는다.
- Obsidian의 `SecretStorage`가 있으면 OAuth 세션을 보관한다. 이 API가 없는 이전 버전은 메모리에서만 세션을 유지하고, 앱을 다시 열면 로그인한다. OAuth 토큰을 `data.json`에 저장하는 대체 경로는 두지 않는다.
- 기존 PAT 설정은 고급 설정에 유지한다. GitHub 로그인 실패 시 PAT로 자동 전환하지 않는다. PAT를 선택한 경우 기존 평문 저장 방식이 적용된다.
- OAuth 세션은 토큰을 발급한 relay 주소에 묶는다. 다른 서버로 주소를 바꾸기 전에 연결을 해제해야 하며, 기존 refresh token을 새 주소로 전송하지 않는다.
- 공개 배포는 HTTPS를 사용한다. 개발용 HTTP는 명시적으로 허용한 loopback 주소에서만 사용한다.

## API 계약

JSON 요청과 응답은 UTF-8을 사용한다. 토큰 응답에는 `Cache-Control: no-store`를 적용한다.

| 요청 | 입력 | 성공 응답 또는 동작 |
| --- | --- | --- |
| `GET /auth/config` | 없음 | `{ clientId, appSlug, installationUrl, callbackUrl }` |
| `POST /auth/start` | `{ codeChallenge, clientState }` | `{ transactionId, authorizationUrl, expiresAt }` |
| `GET /auth/callback` | GitHub의 `state`, `code` 또는 `error` | 검증 후 고정된 Obsidian 복귀 링크 제공 |
| `POST /auth/complete` | `{ transactionId, codeVerifier }` | 아래의 토큰 응답 |
| `POST /auth/cancel` | `{ transactionId, codeVerifier }` | 검증 후 대기 상태 삭제, `204` |
| `POST /auth/refresh` | `{ refreshToken }` | 새 토큰 응답 |
| `POST /auth/revoke` | `{ accessToken }` | 해당 토큰의 GitHub 회수 요청 |

`expiresAt`은 Unix epoch 기준 밀리초다. 토큰 응답은 GitHub와 같은 snake_case 필드인 `access_token`, `refresh_token`, `expires_in`, `refresh_token_expires_in`, `token_type`을 사용한다. `expires_in`과 `refresh_token_expires_in`의 단위는 초다. 서버와 플러그인 모두 필요한 필드와 유효한 만료 값을 확인한다.

## 로그인 순서

1. 플러그인은 암호학적 난수로 PKCE verifier와 `clientState`를 만든다. `S256` challenge를 계산하고, 원본 vault의 메모리에 verifier와 대기 상태를 둔다.
2. `/auth/start`는 별도의 난수 `transactionId`와 GitHub용 OAuth `state`를 생성한다. 서버는 이 값들과 challenge, `clientState`, 만료 시각을 하나의 트랜잭션으로 묶는다. GitHub 인증 URL에는 `code_challenge`, `code_challenge_method=S256`, OAuth `state`, 고정된 callback URL, `scope=offline_access`를 포함한다.
3. 사용자는 외부 브라우저에서 GitHub에 로그인하고 앱을 승인한다. 저장소 접근은 GitHub App 설치에서 선택한 저장소와 Contents 권한에 따른다. 사용자 승인과 저장소 설치는 별도 단계이므로, 승인만으로 업로드 권한이 생겼다고 판단하지 않는다. 플러그인은 쓰기 권한이 확인된 공개 저장소를 사용자가 선택한 뒤 업로드를 허용한다. 새 로그인에서 이전 PAT의 저장소를 자동 선택하지 않는다.
4. `/auth/callback`은 서버에 저장된 OAuth `state`, 만료 시각, 처리 상태를 확인한다. 정상 코드 또는 허용된 거절 결과를 보관한다. 같은 트랜잭션의 callback을 다시 받아 코드를 덮어쓰지 않는다.
5. 브라우저에는 다음 형태의 고정 링크를 제공한다. 여기에 authorization code, verifier, 토큰, vault 이름을 넣지 않는다.

   ```text
   obsidian://image-paste-on-github-auth?transaction_id=...&state=...
   ```

6. 플러그인은 원본 vault의 대기 상태와 `transaction_id`, `state`가 일치할 때만 완료 요청을 보낸다. 다른 vault로 복귀한 경우 무시한다. 사용자는 원본 vault의 **Complete sign in** 버튼으로 같은 요청을 다시 시작할 수 있다. 이 버튼도 저장된 verifier를 사용한다.
7. `/auth/complete`는 verifier의 S256 값과 저장된 challenge를 비교한다. GitHub 승인이 아직 끝나지 않았으면 `409 authorization_pending`을 반환하고 대기 상태를 유지한다. 잘못된 verifier는 트랜잭션을 소비하지 않는다.
8. 정상 완료 요청은 GitHub 호출 전에 상태를 처리 중으로 바꾼다. 저장된 code, verifier, 서버의 `client_secret`, 고정 callback URL로 토큰을 교환한다. 성공한 토큰은 HTTPS 응답으로만 전달하고 트랜잭션을 제거한다. 동시 완료 요청과 재사용은 거절한다.

GitHub의 PKCE 지원은 `client_secret` 요구를 없애지 않는다. 따라서 코드 교환은 서버에서 수행한다. GitHub 인증 URL과 설치 URL은 GitHub의 고정된 origin과 경로만 사용하며, callback 입력에서 임의 URL을 받아 열지 않는다.

## 만료, 취소, 재시도

트랜잭션은 최대 10분 동안 서버 메모리에만 유지한다. 만료되거나 서버가 재시작되면 로그인을 다시 시작한다. 서버는 단일 인스턴스로 운영한다. 여러 인스턴스로 확장하려면 상태 공유가 추가로 필요하다.

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
- JSON 본문 크기, 필드 길이, 요청 시간, GitHub 응답 크기, 동시 요청 수, 대기 트랜잭션 수를 제한한다. 시작, 완료, 갱신, 회수 요청에는 IP 기준 요청 제한을 둔다.
- 프록시 주소 헤더는 신뢰할 프록시를 명시적으로 구성한 경우에만 사용한다. 공개 클라이언트의 CORS나 Origin 검사는 인증을 대신하지 않는다.
- callback 페이지는 외부 스크립트와 리소스를 사용하지 않는다. 고정 링크의 값은 URL 인코딩과 HTML escaping을 적용하고, `no-store`, `Referrer-Policy: no-referrer`, 제한적인 CSP를 적용한다.
- 애플리케이션과 역방향 프록시는 callback query, 요청 본문, Authorization 헤더, 코드, 토큰을 로그에 남기지 않는다. 오류 응답은 정해진 코드와 문구로 제한한다.
- Docker 이미지에 secret이나 `.env` 파일을 포함하지 않는다. 서버는 비관리자 사용자로 실행하고, 실제 secret은 실행 환경에서 주입한다.

## 검증 기준

모의 GitHub를 사용하는 테스트는 정상 로그인 외에 잘못된 state와 verifier, callback 재사용, 동시 완료 요청, 만료, 취소, 승인 전 완료 요청, GitHub 거절, timeout과 잘못된 응답을 확인한다. callback HTML과 deep link에 code나 토큰이 없어야 하고, 처리된 code를 다시 교환할 수 없어야 한다.

플러그인 테스트는 다른 vault의 callback 무시, 수동 완료, 로그인 중 취소와 종료, 동시 갱신, 갱신 중 로그아웃, 토큰 저장 실패, relay 주소 변경, PAT로 자동 전환하지 않는 동작을 확인한다. `tests/auth-relay.test.cjs`는 실제 클라이언트와 로컬 HTTP relay를 연결해 PKCE 계산, callback HTML, 갱신, 취소를 확인하되 GitHub 응답은 모의 처리한다. 외부 GitHub 계정이나 secret은 사용하지 않는다.

실제 App과 배포 주소가 준비되면 외부 브라우저에서 승인 후 데스크톱과 모바일로 복귀하는지, 선택한 저장소에만 업로드하는지, 만료 토큰 갱신과 연결 해제가 동작하는지 별도로 확인한다.

## 공식 자료

- [GitHub App 사용자 토큰 발급과 PKCE](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [사용자 토큰 갱신과 rotation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)
- [GitHub App 보안 권장 사항](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app)
- [개별 토큰과 앱 권한 회수 API](https://docs.github.com/en/rest/apps/oauth-applications)
- [Obsidian URI](https://help.obsidian.md/uri)
