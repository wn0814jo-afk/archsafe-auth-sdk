# AUTH_WORKER_CONTRACT.md

> 이 문서는 설계 제안서가 아니라 **runtime behavior lock file**입니다.
> "이래야 한다"가 아니라 "지금 코드가 실제로 이렇게 동작한다" / "앞으로 구현해야 할 것"을 명확히 구분해서 고정합니다.
> **✅ = 이미 구현되고 검증됨 (TC 존재)** / **🔲 = 아직 미구현, 이 계약을 지키며 구현해야 함**

버전: v1.0 (2026-07-05) — 대응 SDK: `archsafe-auth-sdk@v1.1.0`, 대응 App: `ehs-ios@49f04a9`

---

## 1. Identity Model

**JWT는 신원 + 세션 바인딩만 담는다. 권한(role)을 담지 않는다.**

```
{
  "sub": "<user_id>",
  "session_id": "<uuid>",
  "iat": <timestamp>,
  "exp": <iat + 15min>
}
```

- ✅ 클라이언트는 JWT를 절대 decode하지 않는다 — `AuthSDK` 소스에 `jwt.decode`, `atob.*payload` 패턴이 없음을 `TC-AUTH-10`이 매 커밋마다 검증한다 (`auth-sdk.js` 소스 스캔).
- 🔲 `session_id` 필드 자체는 Worker 미구현 상태라 아직 발급되지 않는다. Worker 구현 시 이 필드부터 채워야 SSO/rotation이 성립한다.
- Access JWT는 클라이언트에 노출하지 않는다 (httpOnly 쿠키) — SDK가 이미 모든 요청에 `credentials:'include'`만 쓰고 토큰을 직접 다루지 않는 구조로 되어 있다 (`_doFetch`, `fetchWithAuth`).

**왜 role을 JWT에 넣지 않는가 (결정 근거, 재론 금지 사유)**

EHS 권한(작업허가 승인, 보호조치 해제 등)은 즉시 철회 가능해야 하는 control-plane 권한이다. JWT에 role을 구우면 access token 만료(15분)까지 낡은 권한이 유효하게 남는다. 이 15분 창은 일반 SaaS에서는 허용 가능하지만, 안전 시스템에서는 리스크다. 따라서 role은 **저장값이 아니라 매 조회 시 계산값**이어야 한다 (→ 3번 참조).

---

## 2. Session Model

- `session_id`: 로그인 인스턴스 하나에 대응. 강제 로그아웃(특정 기기/세션만 revoke)의 단위.
- `family_id`: refresh rotation chain 식별자. 하나의 `session_id`는 하나의 `family_id`를 가지며, refresh할 때마다 같은 family 안에서 토큰만 교체된다.
- 🔲 둘 다 Worker 쪽 구현 대상. 저장소는 Cloudflare D1 권장 (아래 4번 rotation 참조).

---

## 3. Authorization Model

**Role은 저장값이 아니라 `/auth/me` 호출 시의 계산값이다.**

```
GET /auth/me  (credentials: include)
→ {
    "user": {
      "id": "u123",
      "roles": { "safetyos": "safety_manager", "checklist": "viewer" }
    }
  }
```

- ✅ 클라이언트(SDK)는 이 JSON 외 어떤 권한 정보도 캐시하지 않는다 — `AuthSDK._user`는 메모리 캐시일 뿐이며 페이지 새로고침 시 소멸한다 (영속 캐시 없음, `TC-AUTH-10`이 `localStorage`/`IndexedDB` 미사용을 검증).
- 🔲 Worker는 `X-ArchSafe-App` 헤더(SDK가 이미 매 요청에 전송 중, `_doFetch` 참조)를 보고 해당 앱에 대한 role만 동적으로 계산해서 응답해야 한다.
- **request-level consistency**: 하나의 위저드 세션 안에서 스텝 이동 중 권한이 바뀌어 UI가 깜빡이는 걸 막기 위해, SDK의 `_user` 메모리 캐시(짧은 수명, 페이지 세션 한정)를 그대로 신뢰 범위로 삼는다. 즉 **"매 스텝마다 `/auth/me` 재호출" 금지** — 이미 SDK가 `getCurrentUser()`에서 캐시가 있으면 재조회 안 함(`TC-AUTH-03`: "2번째: 캐시 반환"). 권한이 실시간으로 바뀌어야 하는 경우(관리자가 강제로 권한 회수)는 `fetchWithAuth`가 401을 받는 시점에 자연히 갱신되며, 이건 이미 존재하는 refresh 경로를 재사용한다 — 별도 polling 불필요.

### `/auth/me`는 순수 조회 전용이다 (v1.2, "A안" 확정)

`/auth/me`(`GET`)는 **세션/토큰을 절대 갱신하지 않는다** — HTTP `GET`이 쓰기 부작용을 가지면 캐싱/로깅/모니터링이 "이건 안전하게 재호출 가능한 조회"라고 가정하는 것과 충돌한다. access token(15분) 자연 만료를 재로그인 없이 넘기는 책임은 **클라이언트(`AuthSDK.requireAuth()`, v1.2)**가 진다 — `/auth/me` 401 → `_refresh()` 1회 시도 → 실패 시에만 `login()` redirect. 검토했던 대안(B안: Worker가 `/auth/me` 안에서 투명하게 refresh)은 기각됨.

---

## 4. Failure Classification (SDK v1.1 기준, 이미 구현됨)

✅ 전부 `auth-sdk.js@v1.1.0`에 구현되고 `run-tests.mjs` TC-AUTH-14~18로 검증됨 (48/48 PASS).

| 상황 | 판정 | SDK 동작 |
|---|---|---|
| `/auth/me` → `401` | `UNAUTHENTICATED` | `getCurrentUser()` → `null`, `requireAuth()` → `login()` redirect |
| `/auth/me` → network error (fetch throw) | `NETWORK_ERROR` (retryable) | `AuthUnavailableError` throw, **redirect 안 함** |
| `/auth/me` → `5xx` | `SERVER_ERROR` (retryable) | `AuthUnavailableError` throw, **redirect 안 함** |
| refresh 성공 직후 후속 `/auth/me` 실패 | (무시) | `refreshIfNeeded()`는 `true` 반환 — refresh 자체 성공과 후속 조회 실패를 분리 |
| refresh 실패 (401) | 세션 만료 확정 | `logout()` + `AuthExpiredError` throw |

**핵심 불변 조건**: `NETWORK_ERROR`/`SERVER_ERROR`는 절대 `logout()`이나 `login()` redirect를 트리거하지 않는다. Worker가 일시적으로 죽어도 이미 로그인된 사용자를 강제로 로그아웃시키지 않는다.

---

## 5. SSO Rule

- 🔲 **`.archsafe.co.kr` 서브도메인 필수** — 쿠키 `Domain=.archsafe.co.kr` 공유가 SSO 성립의 전제 조건. 현재 SafetyOS는 `safety-investigation.pages.dev`에 배포되어 있어 **SSO가 성립하지 않는 상태**. Worker 배포 전에 커스텀 도메인(`safetyos.archsafe.co.kr`) 연결이 선행되어야 한다.
- `*.pages.dev`는 개발/프리뷰 환경으로만 취급하고, 이 환경에서는 SSO 미보장을 문서상 명시한다.
- SSO 판단 기준은 쿠키 존재 여부가 아니라 `session_id` 일치 여부 — 여러 앱이 같은 `session_id`를 공유하면 자동 로그인 상태로 간주.
- CORS: `Access-Control-Allow-Origin`은 화이트리스트 echo 방식(와일드카드 불가, credentials 사용 시).

---

## 6. Rotation Model

- 🔲 Refresh token은 opaque string (JWT 아님).
- Rotation chain은 **선형(linear)만 허용** — 분기 금지.
- **Reuse detection**: 이미 rotate되어 무효화된 refresh token이 재사용되면 → 탈취 의심 → 해당 `family_id` 전체 즉시 revoke.
- Refresh 성공 ≠ 암묵적 신뢰 — 이전 토큰은 즉시 무효화되어야 함(재사용 탐지의 전제 조건).

| 상황 | Worker 동작 |
|---|---|
| 정상 refresh (최초 사용) | 새 access+refresh 발급, 이전 refresh 즉시 invalidate |
| refresh 만료 (30일 경과) | 401 |
| **이미 무효화된 refresh 재사용** | 해당 `family_id` 전체 revoke + 감사 로그 기록 |

---

## 7. UI Auth Gate Model

✅ `ehs-ios@49f04a9`에 구현됨 — security boundary 정의로 취급 (UX 이슈 아님).

- `<body class="auth-pending">` 기본 부여. CSS로 `.app-shell` 등 body 직계 자식 전체를 `requireAuth()` 성공 전까지 은닉.
- 예외: 에러/재시도/로그아웃 오버레이는 `auth-overlay-visible` 클래스로 항상 표시.
- `requireAuth()` 성공 시에만 `auth-pending` 제거 → 그 시점부터 `BOOT_TASKS`(위저드 초기화) 실행.
- 이 게이트는 `AppState`/`STEP_MAP`을 참조하지 않는다 (양방향 비참조 원칙 유지) — `auth-gate.js`는 순수 인증 레이어, `AppState`는 인증을 모른다.

---

## 8. 아직 미구현 항목 요약 (Worker 구현 시 이 문서를 계약으로 사용)

- [ ] `session_id` / `family_id` 발급 및 D1 저장
- [ ] `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/me` 4개 엔드포인트
- [ ] Reuse detection + family revoke 로직
- [ ] `safetyos.archsafe.co.kr` 커스텀 도메인 연결 (Cloudflare Pages)
- [ ] CORS 화이트리스트 설정
