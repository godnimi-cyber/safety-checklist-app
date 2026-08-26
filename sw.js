/* sw.js — 서비스워커.
 *
 * 두 가지를 해결한다:
 *  1) 설치 아이콘 — 크로미움 계열(크롬·삼성인터넷)은 **fetch 핸들러를 가진 서비스워커**가
 *     있어야 "앱 설치"를 제안한다. 매니페스트·아이콘·HTTPS 는 이미 갖췄고 이것만 없었다.
 *  2) 오프라인 콜드스타트 — 이게 더 중요하다. 워커가 없으면 앱 껍데기가 캐시되지 않아,
 *     신호 없는 현장에서 앱을 **처음 열면 화면 자체가 안 뜬다**. 미전송 큐·임시저장 같은
 *     오프라인 장치는 전부 "앱이 이미 떠 있다"를 전제로 하는데 그 전제가 깨져 있었다.
 *
 * ── 캐시 전략: **네트워크 우선, 캐시는 대비책** ─────────────────────────────
 * 서비스워커의 고전적 사고는 "현장 기기에 옛 코드가 박혀 업데이트가 안 되는" 것이다.
 * 캐시 우선(cache-first)이면 새 버전을 배포해도 기기가 옛 파일을 계속 쓴다.
 * 네트워크 우선이면 통신될 때 **항상** 최신을 받고, 안 될 때만 마지막으로 받은 것을 쓴다.
 * 이 앱은 현장에서 하루에도 여러 번 신호가 끊겼다 붙었다 하므로 이 방향이 맞다.
 * (속도 손해는 있다. 하지만 잘못된 버전으로 점검을 작성하는 것보다 낫다.)
 *
 * ── 캐시하지 않는 것 ────────────────────────────────────────────────
 * **API(Apps Script) 응답은 절대 캐시하지 않는다.** 마스터·예정계획을 낡은 값으로 주면
 * 없는 공사·퇴사한 점검자로 점검이 만들어지고, 그건 조용히 틀린 기록이 된다.
 * 여기서는 아예 손대지 않고 브라우저에 그대로 넘긴다(앱이 자체 캐시·큐로 이미 다룬다).
 */

/* 배포마다 바뀌어야 옛 캐시가 정리된다. config.js 의 APP_VER 과 같은 값을 쓴다
   (tests-js/wiring.test.mjs 가 둘이 어긋나면 잡는다 — 어긋나면 옛 캐시가 영영 남는다). */
var CACHE = 'safety-checklist-v0.5.5-0ff58303';

/* 껍데기 = 앱을 띄우는 데 필요한 최소 집합. config.js 는 API 주소·키라 반드시 포함한다.
   버전 쿼리(?v=)는 넣지 않는다 — 요청 URL 과 캐시 키를 맞추는 일을 fetch 쪽에서 한다. */
var SHELL = [
  './',
  './index.html',
  './styles.css',
  './design-kit/tokens.css',
  './config.js',
  './lib.js',
  './logic.js',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

/* 캐시 키는 **절대 URL 로 통일**한다. 설치는 상대경로로 담고(add 가 알아서 푼다) 조회는
   절대 URL 로 하면, 브라우저에서는 맞아떨어지지만 둘이 같다는 보장이 코드에 안 보인다.
   같은 방식으로 푼 값을 쓰면 그 모호함이 사라진다(오프라인 대체가 조용히 빗나가는 것을 막는다). */
function abs_(rel) { return new URL(rel, self.location.href).href; }
var SHELL_URL = abs_('./index.html');

self.addEventListener('install', function (e) {
  /* 한 파일이라도 실패하면 addAll 이 통째로 거부돼 워커가 설치되지 않는다 —
     그러면 오프라인 콜드스타트가 조용히 안 되는 상태로 남는다. 개별로 담고 실패는 넘긴다
     (다음 방문의 네트워크 우선 경로가 다시 채운다). */
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return Promise.all(SHELL.map(function (u) {
        return c.add(abs_(u)).catch(function () { /* 이 파일만 못 담았다 — 뒤에 채워진다 */ });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.map(function (n) {
        return n === CACHE ? null : caches.delete(n);   /* 옛 버전 캐시 정리 */
      }));
    }).then(function () { return self.clients.claim(); })   /* 새로고침 없이 즉시 이 워커가 맡는다 */
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  /* email_send(PDF 발송) 응답은 절대 캐시하지 않는다 — 실명·부적합 사유가 담긴 요청·응답이
     기기 캐시에 남으면 안 된다. email_send 는 다른 action 과 마찬가지로 POST 로만 나가므로
     (app.js realEmailSend) 바로 아래 GET 가드에서 이미 걸러진다 — 명시적으로 다시 적어 둔다:
     이 경로가 network-first 캐시 로직을 절대 타지 않는다는 사실이 우연이 아니라 의도임을 남긴다. */
  if (req.method !== 'GET') return;                       /* 제출(POST)·email_send 는 앱이 직접 처리한다 */

  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;        /* API(email_send 포함)·외부 요청은 손대지 않는다 */

  /* 대시보드는 network-only(웹 대시보드 스펙 §1) — 담지도, 대체하지도 않는다.
     담으면 옛 대시보드가 새 서버 계약과 어긋난 채 박제되고, navigate 대체를 남기면
     오프라인 첫 방문에 점검 앱(index.html)이 대신 뜬다. 온라인 전용 관리자 페이지라
     오프라인엔 브라우저 표준 오류 화면이 정직하다. */
  if (/\/dashboard\.(?:html|js)$/.test(url.pathname)) return;

  /* 캐시 키에서 버전 쿼리를 뗀다. index.html 이 styles.css?v=0.2.0 로 부르는데 캐시에는
     쿼리 없는 주소로 담겨 있어, 그대로 찾으면 오프라인에서 못 찾는다. */
  var keyUrl = url.origin + url.pathname;

  /* **내비게이션(=index.html)은 버전 쿼리를 붙일 수 없는 유일한 주소**다. 그래서 Pages 가
     주는 max-age=600 이 그대로 걸려 배포 후 최대 10분간 옛 index.html 이 오고, 그 안의
     ?v= 도 옛 값이라 하위 자산까지 통째로 옛 버전이 된다. 여기서 재검증을 강제해 그 창을 없앤다.
     no-cache 는 '캐시를 쓰지 말라' 가 아니라 '쓰기 전에 서버에 물어보라' 다 — 안 바뀌었으면
     304 로 끝나므로 현장 데이터 비용은 사실상 그대로다.
     navigate 모드 Request 로는 new Request(req, init) 를 만들 수 없어(사양상 금지) URL 로
     새로 만든다. 정적 페이지라 헤더가 필요 없다. 못 만드는 환경이면 원래 요청을 그대로 쓴다. */
  var fetchReq = req;
  if (req.mode === 'navigate' && typeof Request === 'function') {
    try { fetchReq = new Request(url.href, { cache: 'no-cache', credentials: 'same-origin' }); }
    catch (err2) { fetchReq = req; }
  }

  e.respondWith(
    fetch(fetchReq).then(function (res) {
      /* 성공한 것만 담는다. 404·500 을 담으면 오프라인에서 그 오류를 계속 되돌려준다. */
      if (res && res.ok && res.type === 'basic') {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(keyUrl, copy); });
      }
      return res;
    }).catch(function () {
      /* 통신 실패 — 마지막으로 받은 것을 준다. 그것도 없으면(첫 방문이 오프라인)
         index.html 로 대체해 최소한 앱이 뜨게 한다. */
      return caches.match(keyUrl).then(function (hit) {
        if (hit) return hit;
        if (req.mode === 'navigate') return caches.match(SHELL_URL);
        return Response.error();
      });
    })
  );
});
