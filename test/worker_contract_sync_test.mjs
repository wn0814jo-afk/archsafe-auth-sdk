/* ================================================================
   worker_contract_sync_test.mjs
   실행: node test/worker_contract_sync_test.mjs
   목적: archsafe-auth-sdk(이 레포)가 archsafe-auth-worker/contract-routes.json에
        선언된 라우트를 실제로 그대로 쓰고 있는지 검증한다.
        AUTH_CONTRACT v1.1 §4에서 요구된 "SDK ↔ Worker Contract Sync" 게이트.

   ⚠️ 이 파일을 archsafe-auth-sdk 레포의 test/ 밑에 그대로 복사해 넣을 것.
      archsafe-auth-worker/test/contract_sync_test.mjs와 완전히 같은 2-gate 설계:
        - Environment Gate: sibling 폴더(../archsafe-auth-worker)가 없으면 경고만 하고 exit 0
                             (로컬에서 auth-worker를 안 체크아웃했을 수 있으므로 정상)
        - Contract Gate: sibling 폴더가 있는데 라우트 문자열이 SDK 소스에 없으면 hard fail (exit 1)
      CI에서는 CROSS_REPO_TOKEN으로 archsafe-auth-worker를 같이 체크아웃해서
      Contract Gate가 항상 돌게 만든다 (archsafe-auth-worker README 참고).
================================================================ */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIBLING_CONTRACT = path.join(__dirname, '..', '..', 'archsafe-auth-worker', 'contract-routes.json');
const SDK_SOURCE_PATH = path.join(__dirname, '..', 'auth-sdk.js');

console.log('\n═══ Cross-Repo Contract Sync (auth-sdk ⇄ auth-worker) ═══\n');

// ── Environment Gate ──
if (!existsSync(SIBLING_CONTRACT)) {
  console.log("::warning::계약 동기화 검증을 건너뜁니다: 'archsafe-auth-worker' 형제 폴더를 못 찾았습니다.");
  console.log('[WARN] CI라면 CROSS_REPO_TOKEN secret이 설정됐는지 확인하세요. 로컬이라면 정상입니다.');
  process.exit(0);
}

// ── Contract Gate ──
const contract = JSON.parse(readFileSync(SIBLING_CONTRACT, 'utf-8'));
const sdkSource = readFileSync(SDK_SOURCE_PATH, 'utf-8');

let PASS = 0, FAIL = 0;
function check(label, cond) {
  if (cond) {
    console.log('[PASS] ' + label);
    PASS++;
  } else {
    console.error('[FAIL] ' + label);
    FAIL++;
  }
}

// path의 {provider} 같은 템플릿 파라미터는 SDK가 리터럴 문자열로 안 갖고 있을 수 있으므로
// 고정 prefix(예: '/auth/callback/')까지만 잘라서 대조한다.
function toCheckableFragment(routePath) {
  const idx = routePath.indexOf('{');
  return idx === -1 ? routePath : routePath.slice(0, idx);
}

for (const ep of contract.endpoints) {
  if (ep.sdkCalls === false) continue; // SDK가 직접 호출하지 않는 경로는 검사 대상 아님 (note 필드 참고)
  const fragment = toCheckableFragment(ep.path);
  check(
    `SDK 소스에 라우트 경로 포함: ${ep.method} ${ep.path} (검사 대상: "${fragment}")`,
    sdkSource.includes(fragment)
  );
}

check(
  `accessTokenTransport=cookie 계약과 일치 (SDK가 Authorization 헤더로 토큰을 직접 다루지 않음)`,
  contract.accessTokenTransport !== 'cookie' || !/Authorization['"]?\s*:\s*`?Bearer/.test(sdkSource)
);

check(
  `SDK가 credentials:'include'로 쿠키 자동 전송 (cookie 모델 전제)`,
  sdkSource.includes("credentials: 'include'") || sdkSource.includes('credentials: "include"')
);

console.log('\n══════════════════════════════════');
console.log(`PASS: ${PASS}  FAIL: ${FAIL}`);
console.log(`전체: ${PASS + FAIL}건\n`);
if (FAIL > 0) {
  console.error('❌ SDK가 Worker의 contract-routes.json과 어긋났습니다. 둘 중 하나가 계약을 어긴 것입니다.');
  process.exit(1);
}
console.log('✅ SDK ↔ Worker 계약 동기화 확인됨');
