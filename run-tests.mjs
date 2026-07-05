import fs from 'node:fs';
import { AuthSDK, AuthExpiredError } from './auth-sdk.js';

let passed = 0, failed = 0;
function assert(label, cond, msg) {
  if (cond) { console.log('  ✅', label); passed++; }
  else       { console.log('  ❌', label, msg ? ('— '+msg) : ''); failed++; }
}

let _mock = null;
globalThis.fetch = (...a) => _mock(...a);
globalThis.window = { location: { href: 'https://safetyos.archsafe.co.kr/' } };
const _ss = {};
globalThis.sessionStorage = {
  getItem: k=>_ss[k]||null, setItem:(k,v)=>{_ss[k]=v;}, removeItem:k=>{delete _ss[k];}
};

async function runAll() {

  /* ── TC-AUTH-01: 생성자 ── */
  console.log('\nTC-AUTH-01: 생성자 계약');
  try { new AuthSDK(); assert('baseUrl 없으면 Error', false); }
  catch(e){ assert('baseUrl 없으면 Error', e.message.includes('baseUrl')); }
  const s1 = new AuthSDK({ baseUrl:'https://auth.archsafe.co.kr/', appId:'safetyos' });
  assert('trailing slash 제거', s1._base==='https://auth.archsafe.co.kr');
  assert('appId 저장',          s1._appId==='safetyos');
  assert('_user null',          s1._user===null);
  assert('version 존재',        !!s1._version);

  /* ── TC-AUTH-02: login() ── */
  console.log('\nTC-AUTH-02: login() 계약');
  const s2 = new AuthSDK({ baseUrl:'https://auth.archsafe.co.kr', appId:'test' });
  s2.login('google');
  assert('google redirect',     globalThis.window.location.href.includes('provider=google'));
  s2.login('naver');
  assert('naver redirect',      globalThis.window.location.href.includes('provider=naver'));
  try { s2.login('facebook'); assert('facebook Error', false); }
  catch(e){ assert('허용 외 provider → Error', e.message.includes('허용되지 않은')); }
  assert('return_url 저장됨',   !!globalThis.sessionStorage.getItem('__archsafe_return_url__'));

  /* ── TC-AUTH-03: getCurrentUser 인증됨 ── */
  console.log('\nTC-AUTH-03: getCurrentUser() 인증 상태');
  const s3 = new AuthSDK({ baseUrl:'https://auth.archsafe.co.kr' });
  _mock = async url => {
    if(url.includes('/auth/me')) return {ok:true, json:async()=>({user:{id:'u1',email:'a@b.com'}})};
  };
  const user3 = await s3.getCurrentUser();
  assert('/auth/me → user 반환',   !!user3 && user3.id==='u1');
  assert('메모리 캐시 저장',       s3._user===user3);
  _mock = async()=>{ throw new Error('캐시 미사용'); };
  const user3b = await s3.getCurrentUser();
  assert('2번째: 캐시 반환',       user3b===user3);

  /* ── TC-AUTH-04: getCurrentUser 미인증 ── */
  console.log('\nTC-AUTH-04: getCurrentUser() 미인증');
  const s4 = new AuthSDK({ baseUrl:'https://auth.archsafe.co.kr' });
  _mock = async()=>({ok:false, status:401});
  const user4 = await s4.getCurrentUser();
  assert('미인증: null 반환',      user4===null);
  assert('_user null 유지',        s4._user===null);

  /* ── TC-AUTH-05: fetchWithAuth 정상 ── */
  console.log('\nTC-AUTH-05: fetchWithAuth() 정상 응답');
  const s5 = new AuthSDK({ baseUrl:'https://auth.archsafe.co.kr', appId:'test' });
  let h5 = {};
  _mock = async(url,opts)=>{ h5=opts.headers||{}; return {ok:true,status:200}; };
  const res5 = await s5.fetchWithAuth('https://api.archsafe.co.kr/data');
  assert('200 반환',               res5.status===200);
  assert('X-ArchSafe-App 헤더',    h5['X-ArchSafe-App']==='test');
  assert('X-SDK-Version 헤더',     !!h5['X-SDK-Version']);

  /* ── TC-AUTH-06: 401 → refresh → 재시도 ── */
  console.log('\nTC-AUTH-06: 401 → refresh 1회 → 재시도');
  const s6 = new AuthSDK({ baseUrl:'https://auth.archsafe.co.kr' });
  s6._user = {id:'u1'};
  let apiCalls6 = 0;
  _mock = async url => {
    if(url.includes('/auth/refresh')) return {ok:true, json:async()=>({})};
    if(url.includes('/auth/me'))      return {ok:true, json:async()=>({user:{id:'u1'}})};
    apiCalls6++;
    return apiCalls6===1 ? {ok:false,status:401} : {ok:true,status:200};
  };
  const res6 = await s6.fetchWithAuth('https://api.archsafe.co.kr/data');
  assert('401 → refresh → 200',    res6.status===200);

  /* ── TC-AUTH-07: refresh 실패 → logout + Error ── */
  console.log('\nTC-AUTH-07: refresh 실패 → logout + Error');
  const s7 = new AuthSDK({ baseUrl:'https://auth.archsafe.co.kr' });
  s7._user = {id:'u1'};
  let logout7 = false;
  s7._onLogout = ()=>{ logout7=true; };
  _mock = async url => {
    if(url.includes('/auth/refresh')) return {ok:false,status:401};
    if(url.includes('/auth/logout'))  return {ok:true};
    return {ok:false,status:401};
  };
  try {
    await s7.fetchWithAuth('https://api.archsafe.co.kr/data');
    assert('Error throw', false);
  } catch(e) {
    assert('세션 만료 Error',       e.message.includes('세션이 만료'));
    assert('logout 콜백 호출',      logout7);
    assert('_user null',            s7._user===null);
  }

  /* ── TC-AUTH-08: logout() ── */
  console.log('\nTC-AUTH-08: logout() 계약');
  const s8 = new AuthSDK({ baseUrl:'https://auth.archsafe.co.kr' });
  s8._user = {id:'u1'};
  let cb8 = false;
  s8._onLogout = ()=>{ cb8=true; };
  _mock = async()=>({ok:true});
  await s8.logout();
  assert('_user null',             s8._user===null);
  assert('콜백 호출됨',            cb8);

  /* ── TC-AUTH-09: 네트워크 오류여도 logout 완료 ── */
  console.log('\nTC-AUTH-09: 네트워크 오류여도 logout 로컬 초기화 보장');
  const s9 = new AuthSDK({ baseUrl:'https://auth.archsafe.co.kr' });
  s9._user = {id:'u1'};
  _mock = async()=>{ throw new Error('network'); };
  await s9.logout();
  assert('오류여도 _user null',    s9._user===null);

  /* ── TC-AUTH-10: SDK 순수성 ── */
  console.log('\nTC-AUTH-10: SDK 순수성 — Engine/Storage 의존성 없음');
  const src = fs.readFileSync(new URL('./auth-sdk.js', import.meta.url), 'utf8');
  ['AppState','CapaEngine','IndexedDB','localStorage','jwt.decode','atob.*payload']
    .forEach(pat => assert('SDK: '+pat+' 없음', !new RegExp(pat).test(src)));
  const srcNoComment = src.replace(/\/\/[^\n]*/g,'').replace(/\/\*[\s\S]*?\*\//g,'');
  assert('baseUrl 하드코딩 없음 (코드 내)', !srcNoComment.includes('auth.archsafe.co.kr'));

  /* ── TC-AUTH-11: refresh 1회 제한 — retry 후 401도 AuthExpiredError ── */
  console.log('\nTC-AUTH-11: refresh 1회 제한 — retry 후 401 → AuthExpiredError (silent loop 방지)');
  const s11 = new AuthSDK({ baseUrl:'https://auth.archsafe.co.kr' });
  s11._user = {id:'u1'};
  let logout11 = false;
  s11._onLogout = ()=>{ logout11=true; };
  let refreshCount11 = 0;
  _mock = async url => {
    if(url.includes('/auth/refresh')){ refreshCount11++; return {ok:true,json:async()=>({})}; }
    if(url.includes('/auth/me'))      return {ok:true, json:async()=>({user:{id:'u1'}})};
    if(url.includes('/auth/logout'))  return {ok:true};
    return {ok:false, status:401};
  };
  try {
    await s11.fetchWithAuth('https://api.archsafe.co.kr/data');
    assert('TC-11: AuthExpiredError throw', false);
  } catch(e) {
    assert('TC-11: AuthExpiredError 타입',     e instanceof AuthExpiredError);
    assert('TC-11: refresh 정확히 1회만 호출', refreshCount11===1);
    assert('TC-11: logout 호출됨',             logout11);
  }

  /* ── TC-AUTH-12: concurrent fetchWithAuth — refresh 중복 호출 없음 ── */
  console.log('\nTC-AUTH-12: concurrent fetchWithAuth 2개 — refresh 1회만 실행');
  const s12 = new AuthSDK({ baseUrl:'https://auth.archsafe.co.kr' });
  s12._user = {id:'u1'};
  let refreshCount12 = 0;
  let apiCalls12 = 0;
  _mock = async url => {
    if(url.includes('/auth/refresh')){
      refreshCount12++;
      await new Promise(r=>setTimeout(r,50));
      return {ok:true, json:async()=>({})};
    }
    if(url.includes('/auth/me')) return {ok:true, json:async()=>({user:{id:'u1'}})};
    apiCalls12++;
    return apiCalls12<=2 ? {ok:false,status:401} : {ok:true,status:200};
  };
  await Promise.allSettled([
    s12.fetchWithAuth('https://api.archsafe.co.kr/data1'),
    s12.fetchWithAuth('https://api.archsafe.co.kr/data2'),
  ]);
  assert('TC-12: refresh 중복 없이 1회만 실행', refreshCount12===1,
    refreshCount12+'회 실행됨');

  /* ── TC-AUTH-13: requireAuth — 미인증 시 login redirect, 인증 시 user 반환 ── */
  console.log('\nTC-AUTH-13: requireAuth — 미인증 redirect / 인증 user 반환');
  const s13a = new AuthSDK({ baseUrl:'https://auth.archsafe.co.kr', appId:'safetyos' });
  let loginCalled13 = false;
  s13a.login = (provider) => { loginCalled13=true; };
  _mock = async url => ({ ok:false, status:401 });
  await Promise.race([
    s13a.requireAuth('google'),
    new Promise(r=>setTimeout(r,100)),
  ]);
  assert('TC-13A: 미인증 시 login() 호출됨', loginCalled13);

  const s13b = new AuthSDK({ baseUrl:'https://auth.archsafe.co.kr' });
  _mock = async url => {
    if(url.includes('/auth/me')) return {ok:true, json:async()=>({user:{id:'u99'}})};
  };
  const user13 = await s13b.requireAuth('google');
  assert('TC-13B: 인증 시 user 반환',  !!user13 && user13.id==='u99');

  console.log('\nTC-AUTH-13C: logout 후 token cache 완전 purge');
  const s13c = new AuthSDK({ baseUrl:'https://auth.archsafe.co.kr' });
  s13c._user = {id:'u1'};
  s13c._refreshPromise = Promise.resolve(true);
  _mock = async()=>({ok:true});
  await s13c.logout();
  assert('TC-13C: _user purge',           s13c._user===null);
  assert('TC-13C: _refreshPromise purge', s13c._refreshPromise===null);

  /* ── 결과 ── */
  console.log('\n══════════════════════════════════════');
  console.log(` 결과: ${passed}개 통과 / ${failed}개 실패`);
  console.log('══════════════════════════════════════\n');
  process.exit(failed>0?1:0);
}

runAll().catch(e => { console.error('FATAL:', e); process.exit(1); });
