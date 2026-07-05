/**
 * ArchSafe Auth SDK v1.0
 * ─────────────────────────────────────────────────────────────
 * 원칙:
 *   - AUTH_CONTRACT_FINAL_v1.0만 소비
 *   - JWT 직접 해석 금지 (/auth/me만 사용)
 *   - Framework 의존성 없음 (순수 ES Module)
 *   - Cloudflare Pages / PWA / Tauri / Electron 공통 사용
 *   - Engine / Snapshot / Report와 완전 분리
 *   - 401 발생 시 자동 refresh 1회, 실패 시 즉시 logout
 *   - Fail-fast: 계약 위반 시 즉시 오류 반환
 *
 * 사용법:
 *   import { AuthSDK } from './auth-sdk.js';
 *   const auth = new AuthSDK({ baseUrl: 'https://auth.{your-domain}.co.kr' });
 *   await auth.requireAuth();  // 미인증 시 자동 login redirect
 *   const user = await auth.getCurrentUser();
 *   const res  = await auth.fetchWithAuth('/api/data');
 */

const SDK_VERSION = '1.0.0';

/* ── 내부 상수 ──────────────────────────────────────────────── */
const STORAGE_KEY_USER   = '__archsafe_user__';
const STORAGE_KEY_RETURN = '__archsafe_return_url__';

/* ── 허용 OAuth provider 목록 ───────────────────────────────── */
const ALLOWED_PROVIDERS = ['google', 'naver'];

/**
 * 인증 만료 에러 — refresh 실패 시 throw
 * 호출부에서 instanceof AuthExpiredError로 구분 가능
 */
export class AuthExpiredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthExpiredError';
  }
}

export class AuthSDK {

  /**
   * @param {object} config
   * @param {string} config.baseUrl      - Auth Worker URL (예: https://auth.archsafe.co.kr)
   * @param {string} [config.appId]      - 앱 식별자 (로그 추적용)
   * @param {function} [config.onLogout] - 로그아웃 시 콜백 (선택)
   */
  constructor(config = {}) {
    if (!config.baseUrl) throw new Error('[AuthSDK] baseUrl은 필수입니다.');
    this._base     = config.baseUrl.replace(/\/$/, '');
    this._appId    = config.appId || 'unknown';
    this._onLogout = config.onLogout || null;
    this._user           = null;   /* 메모리 캐시 */
    this._refreshPromise = null;   /* concurrent refresh dedup */
    this._version  = SDK_VERSION;
  }

  /* ══════════════════════════════════════════════════════════
     PUBLIC API
  ══════════════════════════════════════════════════════════ */

  /**
   * login(provider)
   * OAuth 로그인 redirect.
   * 현재 URL을 return_url로 저장하고 Auth Worker의 OAuth 시작점으로 이동.
   *
   * @param {'google'|'naver'} provider
   */
  login(provider = 'google') {
    if (!ALLOWED_PROVIDERS.includes(provider)) {
      throw new Error(`[AuthSDK] 허용되지 않은 provider: ${provider}`);
    }
    /* 현재 URL 저장 — 로그인 완료 후 복귀 */
    try {
      sessionStorage.setItem(STORAGE_KEY_RETURN, window.location.href);
    } catch (_) {}

    window.location.href = `${this._base}/auth/login?provider=${provider}&app=${encodeURIComponent(this._appId)}`;
  }

  /**
   * logout()
   * Auth Worker에 로그아웃 요청 → 로컬 캐시 초기화.
   */
  async logout() {
    try {
      await fetch(`${this._base}/auth/logout`, {
        method:      'POST',
        credentials: 'include',
      });
    } catch (_) {
      /* 네트워크 오류여도 로컬은 반드시 초기화 */
    }
    this._clearLocal();
    if (this._onLogout) this._onLogout();
  }

  /**
   * getCurrentUser()
   * 현재 인증된 사용자 정보 반환.
   * 메모리 캐시 → /auth/me 순으로 조회.
   * 미인증이면 null 반환 (throw 안 함).
   *
   * @returns {object|null} user
   */
  async getCurrentUser() {
    if (this._user) return this._user;
    return await this._fetchMe();
  }

  /**
   * requireAuth(provider?)
   * 인증 필수 진입점. 미인증이면 login() redirect.
   * 앱 최상단에서 호출.
   *
   * @param {'google'|'naver'} [provider='google']
   * @returns {object} user
   */
  async requireAuth(provider = 'google') {
    const user = await this.getCurrentUser();
    if (!user) {
      this.login(provider);
      /* redirect 전 실행 중단 (빈 Promise 반환) */
      return new Promise(() => {});
    }
    return user;
  }

  /**
   * isAuthenticated()
   * 현재 인증 상태 확인 (boolean).
   *
   * @returns {boolean}
   */
  async isAuthenticated() {
    const user = await this.getCurrentUser();
    return !!user;
  }

  /**
   * fetchWithAuth(url, options?)
   * 인증 헤더 포함 fetch. 401 시 refresh 1회 후 재시도.
   * refresh 실패 시 logout 후 Error throw.
   *
   * @param {string} url
   * @param {RequestInit} [options]
   * @returns {Response}
   */
  async fetchWithAuth(url, options = {}) {
    const res = await this._doFetch(url, options);

    if (res.status !== 401) return res;

    /* 401 → refresh 1회 시도 (이후 재시도 없음 — infinite loop 방지) */
    const refreshed = await this._refresh();
    if (!refreshed) {
      await this.logout();
      throw new AuthExpiredError('[AuthSDK] 세션이 만료됐습니다. 다시 로그인하세요.');
    }

    /* refresh 성공 → 원 요청 1회 재시도 */
    const retryRes = await this._doFetch(url, options);
    /* retry 후에도 401이면 즉시 logout + Error (silent loop 방지) */
    if (retryRes.status === 401) {
      await this.logout();
      throw new AuthExpiredError('[AuthSDK] 재인증 실패. 다시 로그인하세요.');
    }
    return retryRes;
  }

  /**
   * refreshIfNeeded()
   * 명시적 refresh 호출 (선택적 사용).
   * 보통 fetchWithAuth가 자동으로 처리하므로 직접 호출 불필요.
   *
   * @returns {boolean} 성공 여부
   */
  async refreshIfNeeded() {
    return await this._refresh();
  }

  /* ══════════════════════════════════════════════════════════
     INTERNAL
  ══════════════════════════════════════════════════════════ */

  /** /auth/me 호출 → user 객체 반환 (실패 시 null) */
  async _fetchMe() {
    try {
      const res = await fetch(`${this._base}/auth/me`, {
        credentials: 'include',
      });
      if (!res.ok) return null;
      const data = await res.json();
      /* Auth Worker 응답 계약: { user: { id, email, name, role, ... } } */
      if (!data || !data.user) return null;
      this._user = data.user;
      return this._user;
    } catch (_) {
      return null;
    }
  }

  /** Access Token refresh 시도 */
  async _refresh() {
    /* concurrent refresh dedup — Promise 공유로 중복 호출 방지 */
    if (this._refreshPromise) {
      return await this._refreshPromise;
    }

    this._refreshPromise = (async () => {
      try {
        const res = await fetch(`${this._base}/auth/refresh`, {
          method:      'POST',
          credentials: 'include',
        });
        if (!res.ok) return false;
        this._user = null;
        await this._fetchMe();
        return true;
      } catch (_) {
        return false;
      }
    })();

    try {
      return await this._refreshPromise;
    } finally {
      this._refreshPromise = null;
    }
  }

  /** fetch 공통 래퍼 */
  async _doFetch(url, options) {
    return await fetch(url, {
      ...options,
      credentials: 'include',   /* Refresh Token 쿠키 자동 포함 */
      headers: {
        'X-ArchSafe-App': this._appId,
        'X-SDK-Version':  this._version,
        ...(options.headers || {}),
      },
    });
  }

  /** 로컬 상태 초기화 */
  _clearLocal() {
    this._user           = null;
    this._refreshPromise = null;
    try {
      sessionStorage.removeItem(STORAGE_KEY_USER);
    } catch (_) {}
  }

  /** ms 대기 */
  _wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * OAuth callback 처리 유틸
 * ─────────────────────────────────────────────────────────────
 * Auth Worker의 callback redirect 후 앱에서 호출.
 * return_url로 자동 복귀.
 *
 * 사용법 (callback.html 또는 index.html에서):
 *   import { handleOAuthCallback } from './auth-sdk.js';
 *   await handleOAuthCallback();
 */
export async function handleOAuthCallback() {
  const params = new URLSearchParams(window.location.search);
  const error  = params.get('error');

  if (error) {
    console.error('[AuthSDK] OAuth 오류:', error);
    window.location.href = '/';
    return;
  }

  /* Auth Worker가 쿠키 세팅 완료 → return_url 복귀 */
  let returnUrl = '/';
  try {
    returnUrl = sessionStorage.getItem(STORAGE_KEY_RETURN) || '/';
    sessionStorage.removeItem(STORAGE_KEY_RETURN);
  } catch (_) {}

  window.location.href = returnUrl;
}
