/* SafetyMove — 주소 이전(옛 GitHub Pages 주소 → 새 주소). 브라우저(전역)/Node(require) 겸용.
 *
 * CONFIG.MOVED_TO 가 비어 있으면(이 저장소의 기본값·새 주소 배포) 이동 쪽 함수는 아무것도 하지
 * 않는다. 옛 저장소에만 tools/build_moved_site.py 로 MOVED_TO 를 채운 빌드를 올린다.
 * localStorage 는 주소(origin)마다 따로라 옛 주소의 미전송 큐·작성 중 초안은 따라가지 않는다 —
 * 그래서 점검 앱은 그것들이 비었을 때만 자동으로 옮긴다(판단은 decide, 배선은 app.js).
 */
var SafetyMove = (function () {
  var REPO_PREFIX = '/safety-checklist-app';
  var NOTICE_KEY_PREFIX = 'sc_moved_notice_';
  var ORIGIN_RE = /^https:\/\/[^\/?#]+/i;

  /** MOVED_TO 를 끝 슬래시 없는 https 기준 주소로. 쓸 수 없는 값이면 '' (= 이동 안 함). */
  function normalizeTarget(movedTo) {
    var s = String(movedTo || '').trim();
    if (!ORIGIN_RE.test(s) || /[?#]/.test(s)) return '';
    return s.replace(/\/+$/, '');
  }

  function hasFromOld(search) {
    return /(?:^\?|&)from=old(?:&|$)/.test(String(search || ''));
  }

  /** 옮겨 갈 주소. 이동하지 않을 때(MOVED_TO 빈 값·잘못된 값·이미 같은 origin)는 ''. */
  function targetUrl(movedTo, loc) {
    var base = normalizeTarget(movedTo);
    if (!base || !loc) return '';
    if (ORIGIN_RE.exec(base)[0].toLowerCase() === String(loc.origin || '').toLowerCase()) return '';
    var path = String(loc.pathname || '/');
    if (path === REPO_PREFIX) path = '/';
    else if (path.indexOf(REPO_PREFIX + '/') === 0) path = path.slice(REPO_PREFIX.length);
    var search = String(loc.search || '');
    if (search === '?') search = '';
    if (!hasFromOld(search)) search += (search ? '&' : '?') + 'from=old';
    return base + path + search + String(loc.hash || '');
  }

  /** 작성 중 초안 수 — sc_drafts 맵의 항목 + 옛 단일 슬롯(sc_draft)이 남아 있으면 1. */
  function countDrafts(drafts, hasLegacy) {
    var n = (drafts && typeof drafts === 'object') ? Object.keys(drafts).length : 0;
    return n + (hasLegacy ? 1 : 0);
  }

  /** 'stay'(오프라인 — 새 주소는 이 기기에 오프라인 캐시가 없다) / 'hold'(보낼 것·초안이 남음, 또는
      저장 기록이 손상·읽기 실패라 건수를 믿을 수 없음 — o.damaged) / 'move'. */
  function decide(o) {
    if (!o || !o.online) return 'stay';
    if (o.damaged || (o.queue || 0) > 0 || (o.drafts || 0) > 0) return 'hold';
    return 'move';
  }

  /** search 에서 from=old 만 뺀 문자열. from=old 가 없으면 null. */
  function withoutFromOld(search) {
    var s = String(search || '').replace(/^\?/, '');
    if (!s) return null;
    var parts = s.split('&');
    var kept = parts.filter(function (p) { return p !== 'from=old'; });
    if (kept.length === parts.length) return null;
    return kept.length ? '?' + kept.join('&') : '';
  }

  function isOnline(win) {
    return !(win.navigator && win.navigator.onLine === false);
  }

  /* 배너는 페이지마다 하나 — body 맨 앞에 붙이고 다시 그릴 때는 같은 노드를 쓴다. */
  var bannerEl = null;
  function banner(doc, level) {
    if (!bannerEl) {
      bannerEl = doc.createElement('div');
      bannerEl.setAttribute('role', 'status');
      doc.body.insertBefore(bannerEl, doc.body.firstChild || null);
    }
    bannerEl.className = 'banner banner-' + level;
    bannerEl.innerHTML = '';
    return bannerEl;
  }
  function addText(doc, el, text) {
    var span = doc.createElement('span');
    span.className = 'banner-text';
    span.textContent = text;
    el.appendChild(span);
    return span;
  }
  function removeBanner() {
    if (bannerEl) { bannerEl.remove(); bannerEl = null; }
  }

  /** 옛 주소 점검 앱 — 남은 기록(또는 손상된 저장 기록, counts.damaged) 때문에 자동 이동을 미룰 때. */
  var offlineWatched = false;
  function showHold(win, counts, to) {
    var doc = win.document;
    var el = banner(doc, 'warn');
    var text = '앱 주소가 바뀌었습니다. ';
    if (counts.damaged) text += '이 기기에 손상된 저장 기록이 있어 자동 이동하지 않습니다. ';
    if (counts.queue > 0 || counts.drafts > 0 || !counts.damaged) {
      text += '이 기기에 보내지 않은 제출 ' + counts.queue + '건 · 작성 중 초안 ' + counts.drafts + '건이 남아 있어, ' +
        '제출을 마친 뒤 새 주소로 이동합니다. ';
    }
    addText(doc, el, text + '지금 이동하면 이 기기의 보내지 않은 기록은 옛 주소에 남습니다.');
    var go = doc.createElement('button');
    go.type = 'button';
    go.className = 'btn btn-outline';
    go.textContent = '지금 이동';
    /* 온라인일 때 띄운 배너라도 누르는 순간 오프라인일 수 있다 — 새 주소는 이 기기에 캐시가 없어 빈 화면이 된다 */
    var hint = null;
    go.addEventListener('click', function () {
      if (!isOnline(win)) { if (!hint) hint = addText(doc, el, '인터넷 연결 후 다시 누르세요.'); return; }
      win.location.replace(to);
    });
    el.appendChild(go);
    /* 오프라인이 되면 배너를 내린다. online 때는 app.js(watchMoved_)가 다시 판단해 필요하면 다시 띄운다 */
    if (!offlineWatched) { offlineWatched = true; win.addEventListener('offline', removeBanner); }
  }

  /** 옛 주소 점검 앱의 이동 판단·실행. counts = { queue, drafts, damaged }. 옛 주소 빌드가 아니면 아무것도 안 한다. */
  var leaving = false;   /* 이미 replace 를 불렀다 — 같은 판단이 잇달아 와도 한 번만 옮긴다 */
  function applyApp(win, movedTo, counts) {
    var to = targetUrl(movedTo, win.location);
    if (!to) return 'none';
    if (leaving) return 'move';
    var d = decide({ online: isOnline(win), queue: counts.queue, drafts: counts.drafts, damaged: counts.damaged });
    if (d === 'move') { leaving = true; win.location.replace(to); }
    else if (d === 'hold') showHold(win, counts, to);
    else removeBanner();   /* 오프라인 — [지금 이동] 을 누르면 빈 화면이 되므로 내린다 */
    return d;
  }

  /** 대시보드·관리자 — 큐가 없으므로 온라인이면 곧바로 옮긴다. 옮겼으면 true(페이지 초기화를 멈춘다). */
  function leavePage(win, movedTo) {
    var to = targetUrl(movedTo, win.location);
    if (!to) return false;
    if (isOnline(win)) { win.location.replace(to); return true; }
    win.addEventListener('online', function () { win.location.replace(to); });
    return false;
  }

  /** 새 주소 쪽: ?from=old 로 들어왔으면 주소창에서 지우고, 안내 배너를 페이지별 1회 띄운다.
      page = 'app' | 'dashboard' | 'admin'. 옛 주소 빌드(MOVED_TO 있음)에서는 아무것도 안 한다. */
  function noticeNewAddress(win, movedTo, page) {
    if (normalizeTarget(movedTo)) return false;
    var loc = win.location;
    var rest = withoutFromOld(loc.search);
    if (rest === null) return false;
    try { win.history.replaceState(null, '', loc.pathname + rest + (loc.hash || '')); } catch (e) { /* 주소창 정리만 못 했다 */ }
    var key = NOTICE_KEY_PREFIX + page;
    var ls = null;
    try { ls = win.localStorage; if (ls.getItem(key)) return false; } catch (e2) { ls = null; }
    try { if (ls) ls.setItem(key, '1'); } catch (e3) { /* 저장 못 하면 다음에 한 번 더 보일 뿐이다 */ }
    var doc = win.document;
    var el = banner(doc, 'info');
    var text = '주소가 safety.ynes.app 으로 바뀌었습니다 — 홈 화면 아이콘을 이 주소로 다시 설치하세요.';
    if (page !== 'app') text += ' 관리 키는 이 주소에서 다시 입력해야 합니다.';
    addText(doc, el, text);
    var close = doc.createElement('button');
    close.type = 'button';
    close.className = 'banner-close';
    close.setAttribute('aria-label', '알림 닫기');
    close.textContent = '×';
    close.addEventListener('click', removeBanner);
    el.appendChild(close);
    return true;
  }

  return {
    normalizeTarget: normalizeTarget,
    targetUrl: targetUrl,
    countDrafts: countDrafts,
    decide: decide,
    withoutFromOld: withoutFromOld,
    applyApp: applyApp,
    leavePage: leavePage,
    noticeNewAddress: noticeNewAddress
  };
})();
if (typeof module !== 'undefined') module.exports = SafetyMove;
