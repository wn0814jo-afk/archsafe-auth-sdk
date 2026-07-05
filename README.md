# ArchSafe Auth SDK

모든 ArchSafe 앱(SafetyOS, Checklist, RISK 등)이 공통으로 사용하는 인증 클라이언트입니다.

## 설계 원칙

- `AUTH_CONTRACT_FINAL_v1.0`만 소비 — JWT를 직접 해석하지 않고 `/auth/me`만 사용
- Framework 의존성 없음 — 순수 ES Module, Cloudflare Pages / PWA / Tauri / Electron 공통 사용 가능
- Engine / Snapshot / Report 등 앱 내부 로직과 완전 분리
- 401 발생 시 자동 refresh 1회, 실패 시 즉시 logout (silent retry loop 없음)
- Fail-fast — 계약 위반 시 즉시 오류 반환

## 아키텍처 위치

```
Google / Naver OAuth
        ↓
auth.archsafe.co.kr (Auth Worker)
        ↓
Access JWT (15분) + Refresh Rotation (30일)
        ↓
AuthSDK (이 레포)
        ↓
ArchSafe 앱들 (SafetyOS, Checklist, RISK, ...)
```

Auth Worker(`auth.archsafe.co.kr`)는 별도 레포/인프라이며, 이 SDK는 그 계약을 소비하는 클라이언트입니다.

## 설치 / 사용

번들러 없이 바로 import:

```html
<script type="module">
  import { AuthSDK } from './auth-sdk.js';

  const auth = new AuthSDK({
    baseUrl: 'https://auth.archsafe.co.kr',
    appId: 'safetyos',
  });

  const user = await auth.requireAuth(); // 미인증 시 자동 login redirect
  const res  = await auth.fetchWithAuth('/api/data'); // 401 자동 refresh + 재시도
</script>
```

OAuth callback 처리 (callback 페이지):

```js
import { handleOAuthCallback } from './auth-sdk.js';
await handleOAuthCallback();
```

## API

| 메서드 | 설명 |
|---|---|
| `login(provider)` | `'google' \| 'naver'` OAuth 로그인 redirect |
| `logout()` | 로그아웃 요청 + 로컬 캐시 초기화 |
| `getCurrentUser()` | 현재 사용자 반환 (미인증 시 `null`) |
| `requireAuth(provider?)` | 인증 필수 진입점, 미인증 시 자동 redirect |
| `isAuthenticated()` | 인증 여부 boolean |
| `fetchWithAuth(url, options?)` | 인증 fetch, 401 시 refresh 1회 후 재시도 |
| `refreshIfNeeded()` | 명시적 refresh (일반적으로 직접 호출 불필요) |
| `handleOAuthCallback()` | OAuth callback 후 return_url 복귀 처리 |

## 테스트

```bash
npm test
```

`run-tests.mjs`가 `auth-sdk.js`를 ESM으로 직접 import하여 검증합니다 (별도 빌드 산출물 없음 — 단일 소스 유지).

현재 상태: **48/48 PASS**

- 생성자 계약
- login / logout 계약
- getCurrentUser (인증/미인증)
- fetchWithAuth (정상 / 401 refresh / refresh 실패)
- refresh 1회 제한 (silent loop 방지)
- concurrent refresh dedup
- requireAuth (redirect / user 반환)
- SDK 순수성 (앱 내부 의존성 없음, baseUrl 하드코딩 없음)
- **failure classification (v1.1)**: 인증 실패(401) vs 인프라 장애(network/5xx) 구분

## Failure Classification (v1.1)

`/auth/me` 응답을 3가지로 명확히 구분합니다. 이 구분이 없으면 Worker 장애 시 정상 세션을 가진 사용자도 강제로 로그인 페이지로 튕깁니다.

| 상황 | 반환/동작 | `requireAuth()` 결과 |
|---|---|---|
| `401` (진짜 미인증) | `getCurrentUser()` → `null` | `login()` redirect |
| network error / `5xx` (인프라 장애) | `getCurrentUser()` → `AuthUnavailableError` throw (`retryable: true`) | redirect 없이 그대로 throw — 호출부가 재시도 UI 표시 |
| refresh 성공 후 자체 `401` 재확인 실패 | `refreshIfNeeded()` → 정상적으로 `true` 반환 (후속 조회 실패는 refresh 실패로 취급 안 함) | — |

호출부(SafetyOS 등)는 `AuthUnavailableError`를 잡아서 "서버 연결 실패, 재시도" UI를, 그 외 에러는 기존대로 처리하면 됩니다.

## 버전 관리

- 이 SDK는 보안/인증 정책 중심으로 변경되며, 각 소비 앱(SafetyOS 등)의 UI/워크플로 변경 주기와 분리되어 있습니다.
- Breaking change는 semver로 관리하고, 소비 앱은 고정 버전(태그/커밋 SHA) 또는 CDN 버전 경로로 참조하는 것을 권장합니다.
