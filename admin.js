/* admin.js — 안전점검 관리자 페이지 (설계 AI_HQ/_std_work/safety_admin_console_20261015/DESIGN.md §6)
 *
 * 서버 계약(gas/admin.gs):
 *   POST text/plain { action, k: DASH_KEY, sid?, req_id?, payload }
 *   읽기 → { ok, data } / 쓰기 → { ok, code:'DONE', target, changed, data } / 실패 → { ok:false, error:{code,message} }
 *
 * 규칙
 *  - CONFIG 는 API_URL 만 쓴다. SHARED_KEY 는 읽지 않는다(관리 문턱은 DASH_KEY).
 *  - 쓰기는 반드시 확인 시트(대상·바뀌는 값·PIN)를 거친다. 자동 재시도는 하지 않는다(설계 R1-18).
 *  - 쓰기 전에 '미결 요청'({req_id, action, target, payload(PIN 제외), at})을 localStorage 에 적고,
 *    응답(done·rejected)을 받으면 지운다. 응답 유실이면 「결과 확인」(adm_req_status, PIN 불필요).
 *  - 같은 대상에 미결 요청이 남아 있으면 새 요청을 만들지 않는다(확인부터).
 *  - PIN·토큰은 저장하지 않는다. sid 는 sessionStorage(탭을 닫으면 사라짐).
 */
(function () {
  'use strict';

  var KEY_STORE = 'safety_dash_key';          // 대시보드와 같은 관리 키 저장소
  var SID_STORE = 'safety_admin_sid';
  var PENDING_STORE = 'safety_admin_pending';
  var REQUEST_TIMEOUT_MS = 12000;
  var ADMIN_BUILD = '0.5.5-fb9dc6b7';                  // tools/stamp_web_version.py 가 찍는다 — 손으로 고치지 않는다

  var state = { key: '', sid: '', who: null, roles: [], tab: '', gen: 0, viewGen: 0, showDeleted: false };
  var NEVER = function () { return new Promise(function () { /* 버린 응답 — 콜백을 부르지 않는다 */ }); };

  var TABS = [
    { id: 'roster', label: '점검자', role: 'roster' },
    { id: 'ingest', label: '자동등록', role: 'ingest' },
    { id: 'master', label: '공사/협력회사', role: 'master' },
    { id: 'record', label: '기록 정정', role: 'record' },
    { id: 'ops', label: '상태/이력', role: 'ops' },
    { id: 'reqs', label: '확인 필요', role: '' }
  ];

  var ERR = {
    AUTH: '관리 키가 맞지 않습니다 — 키를 다시 입력하세요',
    ADM_DENIED: '로그인할 수 없습니다 — 사번·PIN 을 확인하세요(관리자 권한이 없을 수도 있습니다)',
    ADM_SESSION: '로그인이 만료됐습니다 — 다시 로그인하세요',
    ADM_FORBIDDEN: '이 작업을 할 권한이 없습니다',
    ADM_TARGET_PROTECTED: '관리자 계정은 이 화면에서 바꿀 수 없습니다 — 소유자에게 요청하세요',
    PIN_MISMATCH: 'PIN 이 맞지 않습니다',
    PIN_LOCKED: 'PIN 을 여러 번 틀려 잠시 잠겼습니다 — 10분 뒤 다시 시도하세요',
    CONFLICT: '그사이 다른 변경이 있었습니다 — 목록을 다시 불러온 뒤 하세요',
    OUTCOME_UNKNOWN: '결과를 확인할 수 없습니다 — 「확인 필요」 탭에서 확인하세요',
    LOCK_TIMEOUT: '서버가 바쁩니다 — 잠시 뒤 다시 시도하세요',
    BUSY_INGEST: '자동등록이 실행 중입니다 — 잠시 뒤 다시 시도하세요',
    TARGET_BUSY: '같은 대상에 결과를 확인하지 못한 요청이 있습니다 — 「확인 필요」에서 먼저 닫으세요(제한 역할이면 소유자에게 요청)',
    CONFIG: '서버 설정 문제입니다 — 개발 담당에게 연락하세요',
    NETWORK: '응답을 받지 못했습니다 — 결과를 먼저 확인하세요',
    REQ_REUSED: '같은 요청 번호로 다른 내용을 보냈습니다 — 새로 시도하세요',
    REQ_ABANDONED: '폐기한 요청입니다',
    LOCAL_BUSY: '다른 탭에서 같은 대상에 요청을 보냈습니다 — 「결과 확인」부터 하세요',
    LOCAL_STORE: '이 브라우저에 요청 기록을 남기지 못해 보내지 않았습니다 — 사생활 보호 모드·저장 공간을 확인하세요'
  };
  var VMSG = {
    EXPECT_REQUIRED: '화면이 오래됐습니다 — 다시 불러오세요', STALE_TARGET: '그사이 값이 바뀌었습니다 — 다시 불러오세요',
    REASON_REQUIRED: '사유를 10자 이상 적어 주세요', PIN_FORMAT: '새 PIN 은 숫자 4자리입니다',
    ID_DUP: '이미 있는 사번입니다', ID_INVALID: '사번은 영문·숫자·-·_ 20자 이내', EMAIL_DUP: '다른 활성 점검자와 이메일이 겹칩니다',
    EMAIL_INVALID: '이메일 형식이 맞지 않습니다', NO_CHANGE: '바뀐 내용이 없습니다', SELF_RETIRE: '본인은 퇴사 처리할 수 없습니다',
    CONFIRM_REQUIRED: '미전송 기록이 없는지 확인했다고 체크해 주세요', ALREADY_RETIRED: '이미 퇴사 처리된 점검자입니다',
    NOT_RETIRED: '퇴사 상태가 아닙니다', PROJECT_HAS_PLANS: '예정된 점검 계획이 남아 있어 삭제할 수 없습니다 — 먼저 계획을 취소하세요',
    PROJECT_NAME_DUP: '같은 회사에 같은 이름의 공사가 있습니다', PROJECT_NAME_INVALID: '공사명은 1~60자(작은따옴표로 시작 불가)',
    COMPANY_NAME_CONFLICT: '다른 협력회사(비활성 포함)의 이름·별칭과 겹칩니다', COMMA_NOT_ALLOWED: '이름·별칭에 쉼표를 쓸 수 없습니다',
    NAME_IN_EXCLUDE_LIST: '제외 업체 목록에 있는 이름입니다', ALIAS_DUP: '별칭이 중복됩니다',
    BAD_TRANSITION: '지금 상태에서는 할 수 없는 변경입니다', COMPANY_CHANGE_NOT_ALLOWED: '공사의 회사는 바꿀 수 없습니다',
    NOT_INGEST_OWNED: '그 뒤 다른 메일이나 사람이 바꾼 계획입니다 — 대시보드에서 취소하세요',
    PLAN_ALREADY_DONE: '이미 점검이 끝난 계획입니다', PLANNED_DATE_PAST: '예정일이 지난 계획은 대시보드의 재등록을 쓰세요',
    PROJECT_DELETED: '삭제(숨김)된 공사입니다 — 먼저 공사를 복원하세요', NOTHING_TO_REPROCESS: '재처리 대상이 없습니다',
    CFG_INVALID: '설정 형식 오류', CFG_TOO_LONG: '설정이 너무 깁니다(1,500자 이내)', INTENT_TOO_LARGE: '내용이 너무 깁니다',
    SUBMISSION_NOT_FOUND: '해당 제출이 없습니다', SUBMISSION_ID_INVALID: '제출 ID 형식이 아닙니다',
    RESTORE_CHECK_RATE_LIMITED: '복원 점검은 10분에 한 번만 할 수 있습니다', NOT_APPLIED_YET: '아직 적용된 증거가 없습니다',
    NOT_CONVERGENT: '다시 실행으로 마무리할 수 없는 요청입니다',
    EMAIL_REQUIRED: '이메일을 입력하세요', TEAM_INVALID: '팀 이름이 맞지 않습니다', NAME_INVALID: '이름이 맞지 않습니다',
    DISPLAY_INVALID: '표시 이름이 맞지 않습니다', NOTE_REQUIRED: '설명을 10자 이상 적어 주세요',
    TARGET_CHANGED_SINCE: '그 요청 뒤 대상이 다시 바뀌었습니다 — 실제 상태를 확인하고 「적용됨/적용 안 됨」으로 닫으세요',
    TARGET_REQUIRED: '대상이 없습니다', TARGET_NOT_FOUND: '대상을 찾지 못했습니다 — 목록을 다시 불러오세요',
    ACTIVE_INVALID: '활성 값이 맞지 않습니다', ALIAS_REMOVE_NOT_ALLOWED: '별칭은 지울 수 없습니다(추가만 가능)',
    ALREADY_RESOLVED: '이미 닫힌 요청입니다', CFG_KEY_NOT_ALLOWED: '바꿀 수 없는 설정입니다', CFG_VALUE_INVALID: '설정 값이 맞지 않습니다',
    CURSOR_INVALID: '목록 위치가 맞지 않습니다 — 처음부터 다시 조회하세요', DAYS_INVALID: '기간은 1~60일입니다',
    FIELDS_INVALID: '바꿀 수 없는 항목이 들어 있습니다', ID_NOT_NORMALIZED: '사번 앞뒤 공백을 지우세요',
    INGEST_ID_INVALID: '사전등록 ID 형식이 아닙니다', INGEST_IDS_REQUIRED: '재처리할 항목을 고르세요', INGEST_IDS_TOO_MANY: '한 번에 고를 수 있는 수를 넘었습니다',
    NO_TOKEN: '토큰이 없는 점검자입니다', OUTCOME_INVALID: '처리 결과 값이 맞지 않습니다', REQ_ID_INVALID: '요청 번호 형식이 아닙니다',
    REQ_NOT_FOUND: '요청을 찾지 못했습니다', REQ_NOT_UNKNOWN: '확인 필요 상태의 요청이 아닙니다',
    REQ_REUSED: '같은 요청 번호로 다른 내용을 보냈습니다 — 새로 시도하세요', SUBMISSION_STATE_UNEXPECTED: '제출 상태가 예상과 다릅니다 — 다시 조회하세요',
    NO_OPEN_ACTIVATION: '되돌릴 자동등록이 없습니다', NOT_SKIP_CANCELED: '취소 때문에 건너뛴 항목이 아닙니다',
    REQ_EXISTS: '이미 서버에 도착한 요청이라 폐기할 수 없습니다 — 「결과 확인」을 다시 누르세요',
    ALIAS_INVALID: '별칭이 다른 협력회사(비활성 포함)의 이름·별칭과 겹치거나 형식이 맞지 않습니다',
    PLAN_ALREADY_CANCELED: '이미 취소된 계획입니다', PLAN_NOT_CANCELED: '취소된 계획이 아닙니다', PLAN_NOT_FOUND: '계획을 찾지 못했습니다'
  };

  /* ---------- 유틸 ---------- */
  function $(id) { return document.getElementById(id); }
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'text') n.textContent = String(v);
      else if (k === 'onclick') n.addEventListener('click', v);
      else if (k === 'onchange') n.addEventListener('change', v);
      else n.setAttribute(k, v === true ? '' : String(v));
    });
    (kids || []).forEach(function (c) { if (c != null) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function btn(label, fn, cls) { return el('button', { 'class': 'adm-btn' + (cls ? ' ' + cls : ''), type: 'button', text: label, onclick: fn }); }
  function input(id, label, opts) {
    opts = opts || {};
    return el('label', {}, [label, el(opts.multi ? 'textarea' : 'input', { id: id, type: opts.type || 'text',
      value: opts.value == null ? null : opts.value, placeholder: opts.ph || null, inputmode: opts.inputmode || null, autocomplete: 'off' })]);
  }
  function val(id) { var n = $(id); return n ? String(n.value == null ? '' : n.value).trim() : ''; }
  function card(title, kids) { return el('section', { 'class': 'adm-card' }, [el('h2', { text: title })].concat(kids || [])); }
  function table(cols, rows) {
    return el('div', { 'class': 'adm-tablewrap' }, [el('table', { 'class': 'adm-table' }, [
      el('thead', {}, [el('tr', {}, cols.map(function (c) { return el('th', { text: c }); }))]),
      el('tbody', {}, rows.map(function (r) {
        return el('tr', {}, r.map(function (c) { return el('td', {}, [c == null ? '' : (typeof c === 'object' ? c : String(c))]); }));
      }))
    ])]);
  }
  function msgBox(text, kind) { return el('div', { 'class': 'adm-msg ' + (kind || ''), role: kind === 'err' ? 'alert' : 'status', text: text }); }
  function flash(text, kind) {
    var g = $('adm-global-msg');
    g.textContent = '';
    if (text) g.appendChild(msgBox(text, kind));
  }
  function errText(r) {
    var e = (r && r.error) || {};
    var code = String(e.code || ''), m = String(e.message || '');
    if (code === 'VALIDATION') {
      var head = m.split(' · ')[0].split(',')[0];
      return (VMSG[head] || m || '입력값을 확인하세요') + (VMSG[head] && m.indexOf(' · ') >= 0 ? ' — ' + m.split(' · ').slice(1).join(' · ') : '');
    }
    return ERR[code] || (m || code || '알 수 없는 오류');
  }
  function newReqId() {
    var a = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  function store(kind) {
    try { return kind === 'session' ? window.sessionStorage : window.localStorage; } catch (e) { return null; }
  }
  function sget(kind, k) { var s = store(kind); try { return s ? (s.getItem(k) || '') : ''; } catch (e) { return ''; } }
  function sset(kind, k, v) { var s = store(kind); try { if (s) { if (v) s.setItem(k, v); else s.removeItem(k); } } catch (e) { /* 저장 실패해도 이번 화면은 동작 */ } }

  /* ---------- 통신 ---------- */
  function request(body) {
    return new Promise(function (resolve) {
      var done = false, ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
      var timer = setTimeout(function () {
        if (ctrl) { try { ctrl.abort(); } catch (e) { /* 아래에서 확정 */ } }
        finish({ ok: false, error: { code: 'NETWORK', message: '응답 대기 시간 초과' } });
      }, REQUEST_TIMEOUT_MS);
      function finish(v) { if (done) return; done = true; clearTimeout(timer); resolve(v); }
      fetch(CONFIG.API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body), redirect: 'follow', signal: ctrl ? ctrl.signal : undefined })
        .then(function (res) { return res.json().then(finish, function () { finish({ ok: false, error: { code: 'NETWORK', message: '응답 해석 실패' } }); }); },
              function () { finish({ ok: false, error: { code: 'NETWORK', message: '네트워크 오류' } }); });
    });
  }
  /** 조회. 보낸 뒤 로그아웃·계정 변경·탭 전환이 있었으면 응답을 버린다(Codex P6-R1-05). */
  function read(action, payload) {
    var g = state.gen, v = state.viewGen;
    return request({ action: action, k: state.key, sid: state.sid, payload: payload || {} }).then(function (r) {
      if (g !== state.gen || v !== state.viewGen) return NEVER();
      if (r && !r.ok && r.error && r.error.code === 'ADM_SESSION') logout('로그인이 만료됐습니다 — 다시 로그인하세요');
      if (r && !r.ok && r.error && r.error.code === 'AUTH') { sset('local', KEY_STORE, ''); state.key = ''; route(); }
      return r;
    });
  }

  /* ---------- 미결 요청 ---------- */
  /* 미결 요청은 브라우저 하나에 여러 관리자가 쓸 수 있어 actor(사번)로 나눈다. 남의 미결은 보이지도,
     다시 보내지도 않는다 — 다른 사람 명의로 실행되기 때문이다(Codex P6-R1-10). */
  function pendingRaw() { try { var l = JSON.parse(sget('local', PENDING_STORE) || '[]'); return Array.isArray(l) ? l : []; } catch (e) { return []; } }
  function me() { return state.who ? String(state.who.real_id || '') : ''; }
  function pendingAll() { var m = me(); return pendingRaw().filter(function (p) { return m && p.actor === m; }); }
  function pendingSave(list) {
    var s = list.length ? JSON.stringify(list) : '';
    sset('local', PENDING_STORE, s);
    renderPending();
    return sget('local', PENDING_STORE) === s;            // 다시 읽어 저장됐는지 확인(Codex P6-R1-03)
  }
  function pendingAdd(p) {
    var l = pendingRaw(); l.push(p);
    /* 다시 읽은 값이 방금 쓴 값과 같아야 통과 — 다른 탭이 그 사이 썼으면 물러난다(안전한 쪽).
       두 탭·두 브라우저 동시 전송의 최종 방어는 서버 TARGET_BUSY(잠금 안 원장 검사)다(Codex P6-R2-04). */
    return pendingSave(l);
  }
  function pendingDrop(reqId) { pendingSave(pendingRaw().filter(function (p) { return p.req_id !== reqId; })); }
  function pendingMark(reqId, st) { pendingSave(pendingRaw().map(function (p) { if (p.req_id === reqId) p.state = st; return p; })); }
  /** 같은 대상의 본인 미결. 다른 관리자의 미결은 이 브라우저에서 확인·정리할 길이 없으므로(서버가 상세를 숨긴다)
      여기서 막지 않고, 서버가 잠금 안에서 TARGET_BUSY 로 막는다(Codex P6-R3-02). */
  function pendingFor(target) { return pendingAll().filter(function (p) { return p.target !== '' && p.target === target; })[0]; }

  function renderPending() {
    var box = $('adm-pending'), list = pendingAll();
    box.textContent = '';
    box.hidden = !list.length;
    if (!list.length) return;
    box.appendChild(card('결과를 확인하지 못한 요청', [
      el('p', { 'class': 'adm-muted', text: '응답을 받지 못한 요청입니다. 같은 대상에 새 요청을 보내기 전에 결과부터 확인하세요.' }),
      table(['요청', '대상', '보낸 시각', '상태', ''], list.map(function (p) {
        return [p.action, p.target, p.at, p.state === 'unknown' ? '서버에서 확인 필요' : '응답 없음',
                el('span', {}, [btn('결과 확인', function () { checkPending(p); }, 'ghost')])];
      }))
    ]));
  }
  function checkPending(p) {
    read('adm_req_status', { req_id: p.req_id }).then(function (r) {
      if (!r || !r.ok) { flash(errText(r), 'err'); return; }
      var st = r.data.state;
      if (st === 'done' || st === 'rejected' || st === 'resolved' || st === 'abandoned') {
        pendingDrop(p.req_id);
        flash('요청 결과: ' + st + (r.data.result && r.data.result.error ? ' — ' + errText(r.data.result) : ''), st === 'done' || st === 'resolved' ? 'ok' : 'warn');
        refresh();
      } else if (st === 'not_found') {
        /* 서버에 기록이 없다 — 같은 명령을 같은 req_id 로 다시 보내거나, 서버가 기록하는 폐기를 먼저 한다(설계 R3-03).
           새 PIN 은 저장하지 않았으므로 다시 받는다(Codex P6-R1-02). */
        var body = [el('p', { text: p.action + ' · ' + p.target + ' — 서버에 도착하지 않았습니다. 같은 내용을 다시 보내거나 폐기하세요.' })];
        if (p.needs_new_pin) body.push(input('rs-newpin', '새 PIN 다시 입력(숫자 4자리)', { type: 'password', inputmode: 'numeric' }));
        body.push(btn('이 요청 폐기', function () { abandon(p); }, 'ghost'));
        openSheet({ title: '서버에 기록이 없는 요청', okLabel: '같은 요청 다시 보내기', body: body,
          run: function (pin) {
            var pl = {}; Object.keys(p.payload || {}).forEach(function (k) { pl[k] = p.payload[k]; });
            if (p.needs_new_pin) pl.new_pin = String(($('rs-newpin') || {}).value || '');
            return sendWrite(p.action, pl, pin, p.target, p.req_id);
          } });
      } else {
        /* intent·unknown — 서버가 결과를 정하지 못했다. 닫힐 때까지 같은 대상을 계속 막는다(Codex P6-R1-01). */
        pendingMark(p.req_id, 'unknown');
        flash('서버에서도 결과를 확정하지 못한 요청입니다 — 「확인 필요」 탭에서 닫으면 이 표시도 사라집니다', 'warn');
        if (TABS.some(function (t) { return t.id === 'reqs'; })) selectTab('reqs');
      }
    });
  }
  function abandon(p) {
    request({ action: 'adm_req_abandon', k: state.key, sid: state.sid, req_id: newReqId(), payload: { abandon: p.req_id } }).then(function (r) {
      if (r && r.ok) { pendingDrop(p.req_id); closeSheet(); flash('요청을 폐기했습니다', 'ok'); }
      else if (r && r.error && /REQ_EXISTS/.test(String(r.error.message || ''))) { closeSheet(); checkPending(p); }   // 그사이 도착 — 결과부터
      else flash(errText(r), 'err');
    });
  }

  /* ---------- 확인 시트 + 쓰기 ---------- */
  var sheetRun = null, sheetSeq = 0, sheetBusy = false, sheetOpener = null;
  function openSheet(o) {
    if (sheetBusy) return;                                  // 실행 중에는 다른 시트를 열지 않는다
    sheetSeq++;
    sheetOpener = document.activeElement;
    ['adm-main', 'adm-tabs', 'adm-pending', 'adm-header'].forEach(function (id) { var n = $(id); if (n) n.setAttribute('inert', ''); });
    $('adm-sheet-title').textContent = o.title;
    var b = $('adm-sheet-body'); b.textContent = '';
    (o.body || []).forEach(function (n) { b.appendChild(n); });
    $('adm-sheet-ok').textContent = o.okLabel || '실행';
    $('adm-sheet-ok').className = 'adm-btn' + (o.danger ? ' danger' : '');
    $('adm-sheet-pin').value = '';
    clearMarks();
    $('adm-sheet-err').hidden = true;
    $('adm-sheet-back').hidden = false;
    sheetRun = o.run;
    setTimeout(function () { $('adm-sheet-pin').focus(); }, 0);
  }
  function closeSheet() {
    if (sheetBusy) return;                                  // 응답을 받기 전에는 닫지 않는다(Codex P6-R1-12)
    $('adm-sheet-back').hidden = true; sheetRun = null; $('adm-sheet-pin').value = '';
    ['adm-main', 'adm-tabs', 'adm-pending', 'adm-header'].forEach(function (id) { var n = $(id); if (n) n.removeAttribute('inert'); });
    if (sheetOpener && sheetOpener.focus && document.contains(sheetOpener)) { try { sheetOpener.focus(); } catch (e) { /* 포커스 복원 실패 무시 */ } }
    sheetOpener = null;
  }
  function diff(rows) {
    return el('dl', { 'class': 'adm-diff' }, [].concat.apply([], rows.map(function (r) {
      return [el('dt', { text: r[0] }), el('dd', { text: r[1] })];
    })));
  }

  /** 쓰기 요청. collect() 가 payload(PIN 제외)를 돌려준다 — 확인 시트를 거친다. */
  var BUSY_MSG = '같은 대상에 결과를 확인하지 못한 요청이 있습니다 — 먼저 「결과 확인」 또는 「확인 필요」 탭에서 닫으세요';
  function confirmWrite(o) {
    if (pendingFor(o.target)) { flash(BUSY_MSG, 'warn'); return; }
    /* 서버에 남은 미해소(intent·unknown) 요청도 막는다 — 다른 브라우저에서 보낸 것일 수 있다(Codex P6-R1-01). */
    read('adm_req_list').then(function (lr) {
      if (!lr || !lr.ok) { flash('확인 필요 요청 목록을 불러오지 못해 진행하지 않았습니다 — ' + errText(lr), 'err'); return; }
      if ((lr.data.items || []).some(function (x) { return String(x.target) === String(o.target); })) { flash(BUSY_MSG, 'warn'); return; }
      openConfirm(o);
    });
  }
  function openConfirm(o) {
    openSheet({ title: o.title, okLabel: o.okLabel, danger: o.danger, body: o.body || [],
      run: function (pin) {
        if (pendingFor(o.target)) return Promise.resolve({ ok: false, error: { code: 'LOCAL_BUSY' } });   // 다른 탭이 먼저 보냈다(P6-R1-04)
        var payload = o.collect ? o.collect() : o.payload;
        if (!payload) return Promise.resolve({ ok: false, error: { code: 'VALIDATION', message: '입력값을 확인하세요' } });
        return sendWrite(o.action, payload, pin, o.target, null).then(function (r) {
          if (r && r.ok && o.done) o.done(r);
          return r;
        });
      } });
  }
  function sendWrite(action, payload, pin, target, reuseReq) {
    var reqId = reuseReq || newReqId();
    var clean = {};
    Object.keys(payload || {}).forEach(function (k) { if (!/pin/i.test(k)) clean[k] = payload[k]; });
    if (!reuseReq && !pendingAdd({ req_id: reqId, action: action, target: String(target || ''), payload: clean, actor: me(),
        needs_new_pin: Object.prototype.hasOwnProperty.call(payload || {}, 'new_pin'), state: 'sent', at: new Date().toLocaleString('ko-KR') })) {
      pendingDrop(reqId);
      return Promise.resolve({ ok: false, error: { code: pendingFor(target) ? 'LOCAL_BUSY' : 'LOCAL_STORE' } });   // 미결을 못 적으면 보내지 않는다(P6-R1-03)
    }
    var full = {}; Object.keys(payload || {}).forEach(function (k) { full[k] = payload[k]; });
    full.pin = pin;
    return request({ action: action, k: state.key, sid: state.sid, req_id: reqId, payload: full }).then(function (r) {
      var code = r && r.error && r.error.code;
      if (code === 'NETWORK') return r;                                     // 미결 유지 — 결과 확인으로
      if (code === 'OUTCOME_UNKNOWN') { pendingMark(reqId, 'unknown'); return r; }
      if (code === 'LOCK_TIMEOUT' || code === 'BUSY_INGEST' || code === 'TARGET_BUSY' || code === 'AUTH' || code === 'ADM_SESSION') {
        pendingDrop(reqId); return r;                                        // intent 이전 거절 — 서버 기록 없음
      }
      pendingDrop(reqId);
      return r;
    });
  }

  $('adm-sheet-cancel').addEventListener('click', closeSheet);
  $('adm-sheet-ok').addEventListener('click', function () {
    if (!sheetRun) return;
    var pin = String($('adm-sheet-pin').value || '');
    if (!pin) { showSheetErr('PIN 을 입력하세요'); markField({ error: { code: 'PIN_MISMATCH' } }); return; }
    var okBtn = $('adm-sheet-ok'), label = okBtn.textContent, mySeq = sheetSeq;
    okBtn.disabled = true; sheetBusy = true; $('adm-sheet-cancel').disabled = true;
    var t = setTimeout(function () { okBtn.textContent = '서버 응답 대기…'; }, 1000);
    sheetRun(pin).then(function (r) {
      clearTimeout(t); okBtn.disabled = false; okBtn.textContent = label; sheetBusy = false; $('adm-sheet-cancel').disabled = false;
      if (mySeq !== sheetSeq) return;
      if (r && r.ok) {
        closeSheet();
        flash(writeSummary(r), writeKind(r));
        refresh();
      } else {
        var code = r && r.error && r.error.code;
        if (code === 'NETWORK' || code === 'OUTCOME_UNKNOWN') { closeSheet(); flash(errText(r), 'warn'); renderPending(); }
        else { showSheetErr(errText(r)); markField(r); }
      }
    });
  });
  /* 쓰기 응답 = { ok, data: { code:'DONE', target, changed, data:{ note, warn, masters_stale, … } } }
     재전송 응답은 data.replay·data.resolved 일 수 있다(gas/admin.gs admGuard_). Codex P6-R1-07. */
  function writeParts(r) { var w = (r && r.data) || {}; return { w: w, x: (w.data && typeof w.data === 'object') ? w.data : {} }; }
  function writeSummary(r) {
    var p = writeParts(r), w = p.w, x = p.x, parts = [];
    if (w.resolved) parts.push('이미 처리된 요청입니다(' + (w.resolved.outcome || '닫힘') + ')');
    else parts.push('바뀐 항목: ' + ((w.changed || []).join(', ') || '없음(이미 그 상태)'));
    if (x.warn) parts.push(String(x.warn));
    if (x.note) parts.push(String(x.note));
    if (x.masters_stale) parts.push('현장 앱 명부 갱신 신호를 못 남겼습니다 — 점검자 앱은 다음 실행 때 받습니다');
    return '완료 — ' + parts.join(' · ');
  }
  function writeKind(r) { var x = writeParts(r).x; return (x.warn || x.masters_stale) ? 'warn' : 'ok'; }
  /* 오류를 고칠 입력에 연결한다(aria-invalid·설명·포커스, Codex P6-R4-02). 해당 입력이 시트에 없으면 PIN 칸. */
  var FIELD_OF = {
    ALIAS_INVALID: ['ce-alias', 'cm-alias'], ALIAS_DUP: ['ce-alias', 'cm-alias'], COMMA_NOT_ALLOWED: ['ce-alias', 'cm-alias', 'ce-name', 'cm-name'],
    COMPANY_NAME_CONFLICT: ['ce-name', 'ce-alias', 'cm-name', 'cm-alias'], NAME_IN_EXCLUDE_LIST: ['ce-name', 'cm-name'],
    PIN_FORMAT: ['pi-new', 'rs-newpin', 'ri-pin'], REASON_REQUIRED: ['rc-reason', 'pj-reason', 'rv-reason'], NOTE_REQUIRED: ['rq-note'],
    PROJECT_NAME_INVALID: ['pj-name'], PROJECT_NAME_DUP: ['pj-name'], EMAIL_INVALID: ['ei-email'], EMAIL_DUP: ['ei-email'],
    CONFIRM_REQUIRED: ['rt-confirm'], PIN_MISMATCH: ['adm-sheet-pin'], ADM_DENIED: ['adm-sheet-pin']
  };
  function clearMarks() {
    var list = Array.prototype.slice.call($('adm-sheet-body').querySelectorAll('input, textarea')).concat([$('adm-sheet-pin')]);
    list.forEach(function (n) {
      if (!n) return;
      n.removeAttribute('aria-invalid');
      if (n.getAttribute('aria-describedby') === 'adm-sheet-err') n.removeAttribute('aria-describedby');
    });
  }
  function markField(r) {
    var e = (r && r.error) || {}, key = String(e.code || '');
    if (key === 'VALIDATION') key = String(e.message || '').split(' · ')[0].split(',')[0];
    clearMarks();
    var ids = (FIELD_OF[key] || []).concat(['adm-sheet-pin']);
    for (var i = 0; i < ids.length; i++) {
      var n = $(ids[i]);
      if (n && ($('adm-sheet-body').contains(n) || n === $('adm-sheet-pin'))) {
        n.setAttribute('aria-invalid', 'true'); n.setAttribute('aria-describedby', 'adm-sheet-err');
        try { n.focus(); } catch (x) { /* 포커스 실패 무시 */ }
        return;
      }
    }
  }
  function showSheetErr(t) { var e = $('adm-sheet-err'); e.textContent = t; e.hidden = false; }
  document.addEventListener('keydown', function (e) {
    if ($('adm-sheet-back').hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); closeSheet(); return; }
    if (e.key !== 'Tab') return;
    var f = Array.prototype.filter.call($('adm-sheet').querySelectorAll('button, input, textarea, select, a[href]'),
      function (n) { return !n.disabled && n.offsetParent !== null; });
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    else if (!$('adm-sheet').contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  });

  /* ---------- 로그인 흐름 ---------- */
  function route() {
    state.gen++; state.who = null; state.roles = [];
    state.key = sget('local', KEY_STORE);
    state.sid = sget('session', SID_STORE);
    $('adm-key-view').hidden = !!state.key;
    $('adm-login-view').hidden = !state.key || !!state.sid;
    $('adm-tabs').hidden = !state.sid;
    $('adm-logout').hidden = !state.sid;
    $('adm-main').textContent = '';
    $('adm-who').textContent = '';
    renderPending();
    if (state.key && state.sid) {
      read('adm_whoami').then(function (r) {
        if (!r || !r.ok) return;
        state.who = r.data; state.roles = r.data.roles || [];
        renderPending();                                    // 미결은 계정별 — whoami 뒤에 다시 그린다
        $('adm-who').textContent = (r.data.name || '') + '(' + r.data.real_id + ') · 역할 ' + state.roles.join(',');
        renderTabs();
      });
    }
  }
  function hasRole(role) { return !role || state.roles.indexOf('*') >= 0 || state.roles.indexOf(role) >= 0; }
  function logout(msg) {
    var sid = state.sid;
    sset('session', SID_STORE, '');
    if (sid) request({ action: 'adm_logout', k: state.key, sid: sid, payload: {} });
    route();
    if (msg) flash(msg, 'warn');
  }
  $('adm-key-save').addEventListener('click', function () {
    var v = val('adm-key'); if (!v) return;
    sset('local', KEY_STORE, v); $('adm-key').value = ''; route();
  });
  var loginBusy = false;
  $('adm-login-btn').addEventListener('click', function () {
    if (loginBusy) return;                                  // 두 번 눌러도 한 번만 보낸다(Codex P6-R2-05)
    var id = val('adm-login-id'), pin = String($('adm-login-pin').value || '');
    if (!id || !pin) { flash('사번과 PIN 을 입력하세요', 'err'); return; }
    var g = state.gen, b = $('adm-login-btn');
    loginBusy = true; b.disabled = true;
    request({ action: 'adm_login', k: state.key, payload: { real_id: id, pin: pin } }).then(function (r) {
      loginBusy = false; b.disabled = false;
      $('adm-login-pin').value = '';
      if (g !== state.gen) {                                // 그사이 로그아웃·키 변경 — 이 응답의 세션은 쓰지 않는다
        if (r && r.ok && r.data && r.data.sid) request({ action: 'adm_logout', k: state.key, sid: r.data.sid, payload: {} });
        return;
      }
      if (r && r.ok) { sset('session', SID_STORE, r.data.sid); flash('', ''); route(); }
      else { if (r && r.error && r.error.code === 'AUTH') { sset('local', KEY_STORE, ''); } flash(errText(r), 'err'); route(); }
    });
  });
  $('adm-logout').addEventListener('click', function () { logout('로그아웃했습니다'); });

  function renderTabs() {
    var nav = $('adm-tabs'); nav.textContent = '';
    var vis = TABS.filter(function (t) { return hasRole(t.role); });
    vis.forEach(function (t) {
      nav.appendChild(el('button', { role: 'tab', type: 'button', 'aria-selected': 'false', 'data-tab': t.id, text: t.label,
        onclick: function () { selectTab(t.id); } }));
    });
    if (!vis.length) { $('adm-main').appendChild(msgBox('맡은 역할이 없습니다', 'warn')); return; }
    selectTab(state.tab && vis.some(function (t) { return t.id === state.tab; }) ? state.tab : vis[0].id);
  }
  function selectTab(id) {
    state.tab = id;
    Array.prototype.forEach.call($('adm-tabs').children, function (b) { b.setAttribute('aria-selected', b.getAttribute('data-tab') === id ? 'true' : 'false'); });
    refresh();
  }
  function refresh() {
    var main = $('adm-main');
    if (!state.sid || !state.tab) return;
    state.viewGen++;
    main.textContent = '';
    var loading = msgBox('불러오는 중…', '');
    main.appendChild(loading);
    var t = setTimeout(function () { loading.textContent = '서버 응답 대기(보통 2~4초)…'; }, 1000);
    var vg = state.viewGen;
    (VIEWS[state.tab] || function () { return Promise.resolve(); })(main).then(function () {
      if (vg !== state.viewGen) return;
      clearTimeout(t); if (loading.parentNode) loading.parentNode.removeChild(loading);
    });
  }
  function failInto(main, r) { main.appendChild(msgBox(errText(r), 'err')); }

  /* ---------- 탭: 점검자 ---------- */
  function viewRoster(main) {
    return read('adm_insp_list').then(function (r) {
      if (!r || !r.ok) return failInto(main, r);
      var items = r.data.items || [];
      main.appendChild(card('점검자 추가', [
        el('div', { 'class': 'adm-row' }, [input('ri-id', '사번'), input('ri-team', '팀'), input('ri-name', '이름'),
          input('ri-display', '표시 이름'), input('ri-email', '이메일'), input('ri-pin', '처음 PIN(숫자 4자리)', { type: 'password', inputmode: 'numeric' })]),
        btn('점검자 추가', function () {
          var p = { inspector_id: val('ri-id'), team: val('ri-team'), name: val('ri-name'), display: val('ri-display'), email: val('ri-email') };
          var np = String($('ri-pin').value || '');
          confirmWrite({ action: 'adm_insp_add', target: p.inspector_id, title: '점검자 추가', okLabel: p.name + '(' + p.inspector_id + ') 추가',
            body: [diff([['사번', p.inspector_id], ['팀', p.team], ['이름', p.name], ['표시', p.display || '-'], ['이메일', p.email || '-']]),
                   el('p', { 'class': 'adm-muted', text: '점검자 앱은 다시 실행해야 새 명부를 받습니다.' })],
            collect: function () { p.new_pin = np; return p; } });
        })
      ]));
      main.appendChild(card('명부 (' + items.length + '명)', [
        btn('명부 점검', function () {
          read('adm_insp_check').then(function (c) { flash(c && c.ok ? '명부 점검: ' + JSON.stringify(c.data) : errText(c), c && c.ok ? '' : 'err'); });
        }, 'ghost'),
        table(['사번', '이름', '팀', '상태', 'PIN', '이메일', ''], items.map(function (o) {
          var acts = el('span', {}, []);
          if (o.is_admin) acts.appendChild(el('span', { 'class': 'adm-chip', text: '관리자 — 편집기에서만' }));
          else {
            acts.appendChild(btn('편집', function () { editInsp(o); }, 'ghost'));
            acts.appendChild(btn('PIN 초기화', function () { pinInsp(o, 'adm_insp_pin_reset', 'PIN 초기화'); }, 'ghost'));
            acts.appendChild(btn('잠금 해제', function () {
              confirmWrite({ action: 'adm_insp_unlock', target: o.inspector_id, title: 'PIN 잠금 해제', okLabel: o.name + ' 잠금 해제', payload: { real_id: o.inspector_id } });
            }, 'ghost'));
            if (o.active) acts.appendChild(btn('퇴사', function () { retireInsp(o); }, 'danger'));
            else acts.appendChild(btn('재활성화', function () { pinInsp(o, 'adm_insp_reactivate', '재활성화'); }, 'ghost'));
          }
          return [o.inspector_id, o.name + (o.display ? ' / ' + o.display : ''), o.team, o.active ? '활성' : '퇴사', o.pin_state, o.email, acts];
        }))
      ]));
    });
  }
  function editInsp(o) {
    var fields = ['team', 'name', 'display', 'email', 'alias'];
    var labels = { team: '팀', name: '이름', display: '표시 이름', email: '이메일', alias: '별칭(쉼표 구분)' };
    confirmWrite({ action: 'adm_insp_edit', target: o.inspector_id, title: o.name + '(' + o.inspector_id + ') 편집', okLabel: '저장',
      body: fields.map(function (f) { return input('ei-' + f, labels[f], { value: o[f] || '' }); }),
      collect: function () {
        var set = {}, expect = {};
        fields.forEach(function (f) { var v = val('ei-' + f); if (v !== String(o[f] || '')) { set[f] = v; expect[f] = String(o[f] || ''); } });
        if (!Object.keys(set).length) return null;
        return { real_id: o.inspector_id, set: set, expect: expect };
      } });
  }
  function pinInsp(o, action, label) {
    confirmWrite({ action: action, target: o.inspector_id, title: o.name + ' ' + label, okLabel: o.name + '(' + o.inspector_id + ') ' + label,
      body: [input('pi-new', '새 PIN(숫자 4자리)', { type: 'password', inputmode: 'numeric' }),
             el('p', { 'class': 'adm-muted', text: '새 PIN 은 본인에게 직접 전달하세요. 화면에 다시 보이지 않습니다.' })],
      collect: function () { return { real_id: o.inspector_id, new_pin: String($('pi-new').value || ''), expect: { cred_v: o.cred_v } }; } });
  }
  function retireInsp(o) {
    var cb = el('input', { type: 'checkbox', id: 'rt-confirm' });
    confirmWrite({ action: 'adm_insp_retire', target: o.inspector_id, title: o.name + ' 퇴사 처리', okLabel: o.name + '(' + o.inspector_id + ') 퇴사 처리', danger: true,
      body: [el('p', { text: '토큰을 비우고 비활성으로 바꿉니다. 그 폰에 아직 안 보낸 기록이 있으면 더 보낼 수 없습니다.' }),
             el('label', {}, [cb, ' 그 점검자 폰에 미전송 기록이 없음을 확인했습니다'])],
      collect: function () { return { real_id: o.inspector_id, confirm_queue_empty: !!$('rt-confirm').checked }; } });
  }

  /* ---------- 탭: 자동등록 ---------- */
  var INGEST_FILTERS = [['created', '등록됨'], ['revived', '되살림'], ['dup', '멱등'], ['skip_done', '건너뜀·완료'],
    ['skip_unchecked', '건너뜀·미점검확정'], ['skip_canceled', '건너뜀·취소'], ['skip_not_target', '대상 아님'],
    ['skip_excluded', '제외 업체'], ['held', '보류'], ['rejected', '거절'], ['reverted', '되돌림'], ['processing', '처리 대기']];
  var ingestQuery = { days: 7, results: [], q: '' };
  function viewIngest(main) {
    var filterBox = el('div', { 'class': 'adm-row' }, [
      el('label', {}, ['기간(일)', el('input', { id: 'ig-days', type: 'number', min: 1, max: 60, value: ingestQuery.days })]),
      el('label', {}, ['검색(회사·공사·담당)', el('input', { id: 'ig-q', value: ingestQuery.q })]),
      btn('조회', function () {
        ingestQuery.days = Number(val('ig-days') || 7); ingestQuery.q = val('ig-q');
        ingestQuery.results = INGEST_FILTERS.map(function (f) { return f[0]; }).filter(function (k) { var c = $('ig-f-' + k); return c && c.checked; });
        refresh();
      })
    ]);
    var chips = el('div', { 'class': 'adm-row' }, INGEST_FILTERS.map(function (f) {
      return el('label', { 'class': 'adm-chip' }, [el('input', { type: 'checkbox', id: 'ig-f-' + f[0], checked: ingestQuery.results.indexOf(f[0]) >= 0 }), ' ' + f[1]]);
    }));
    main.appendChild(card('사전등록 결과', [filterBox, chips, el('div', { id: 'ig-results' })]));
    main.appendChild(el('div', { id: 'ig-status' }));
    main.appendChild(el('div', { id: 'ig-cfg' }));
    return Promise.all([
      read('adm_ingest_results', { days: ingestQuery.days, results: ingestQuery.results, q: ingestQuery.q }).then(function (r) {
        var box = $('ig-results'); if (!box) return;
        if (!r || !r.ok) { box.appendChild(msgBox(errText(r), 'err')); return; }
        var d = r.data;
        box.appendChild(el('p', { 'class': 'adm-muted', text: d.since + ' 이후 · ' + Object.keys(d.summary).map(function (k) { return k + ' ' + d.summary[k]; }).join(' · ') +
          (d.truncated ? ' · 2,000건까지만 표시' : '') }));
        if (d.heartbeat_check && !d.heartbeat_check.ok) box.appendChild(msgBox('실행 기록(created ' + d.heartbeat_check.heartbeat_created + ')과 원장(created ' + d.heartbeat_check.ledger_created + ')이 다릅니다 — 개발 담당 확인 필요', 'warn'));
        if (!d.items.length) { box.appendChild(msgBox('해당 기간에 결과가 없습니다', '')); return; }
        box.appendChild(table(['처리일', '원문(회사 · 공사 · 담당)', '결과', '사유', '계획', ''], d.items.map(function (it) {
          var acts = el('span', {}, []);
          if (it.revert.ok) acts.appendChild(btn('이 자동등록 취소', function () { revertRow(it); }, 'danger'));
          if (it.revive.ok) acts.appendChild(btn('취소된 계획 되살리기', function () { reviveRow(it); }, 'ghost'));
          if (/^(skip_|rejected|created|dup|revived|reverted|resolved|shadow)/.test(it.state)) {
            acts.appendChild(btn('재처리 요청', function () { reprocessRow(it); }, 'ghost'));
          }
          if (it.badge === 'UNSKIPPED_NEEDS_REPROCESS') acts.appendChild(el('span', { 'class': 'adm-chip', text: '제외 해제됨 — 재처리 요청 필요' }));
          if (it.badge === 'WILL_SKIP_AGAIN') acts.appendChild(el('span', { 'class': 'adm-chip', text: '다시 건너뛸 예정(제외 목록에 있음)' }));
          if (!it.revert.ok && it.revert.why === 'NOT_INGEST_OWNED') acts.appendChild(el('span', { 'class': 'adm-muted', text: VMSG.NOT_INGEST_OWNED }));
          return [it.batch_date, it.raw_company + ' · ' + it.raw_project + ' · ' + it.raw_owner, it.label,
                  (it.why || '') + (it.reason ? ' [' + it.reason + ']' : ''), it.plan_id ? it.plan_status + ' ' + it.planned_date : '', acts];
        })));
      }),
      read('adm_ingest_status').then(function (r) {
        var box = $('ig-status'); if (!box) return;
        if (!r || !r.ok) { box.appendChild(msgBox(errText(r), 'err')); return; }
        var d = r.data;
        box.appendChild(card('자동등록 상태' + (d.running ? ' — 지금 실행 중' : ''), [
          el('p', { 'class': 'adm-muted', text: '최근 실행: ' + (d.heartbeats.slice(-5).map(function (h) { return h.date + ' ' + h.phase + ' ' + h.note; }).join(' / ') || '없음') }),
          el('h3', { text: '보류 ' + d.held.length + '건 (매일 10시대 자동 재시도)' }),
          d.held.length ? table(['처리일', '원문', '사유'], d.held.map(function (h) { return [h.batch_date, h.raw_company + ' · ' + h.raw_project + ' · ' + h.raw_owner, h.reason]; })) : msgBox('보류된 메일이 없습니다', ''),
          el('h3', { text: '최근 거절 ' + d.rejected.length + '건' }),
          d.rejected.length ? table(['처리일', '원문', '사유'], d.rejected.map(function (h) { return [h.batch_date, h.raw_company + ' · ' + h.raw_project, h.reason]; })) : msgBox('최근 거절이 없습니다', '')
        ]));
      }),
      read('adm_ingest_cfg_get').then(function (r) {
        var box = $('ig-cfg'); if (!box) return;
        if (!r || !r.ok) { box.appendChild(msgBox(errText(r), 'err')); return; }
        var keys = r.data.keys;
        var mk = function (key, label, hint) {
          var cur = keys[key].value;
          return el('div', {}, [
            el('h3', { text: label }), el('p', { 'class': 'adm-muted', text: hint }),
            keys[key].errors.length ? msgBox('지금 값의 문제: ' + keys[key].errors.join(' / '), 'warn') : null,
            el('textarea', { id: 'cfg-' + key }, [cur.split('|').join('\n')]),
            btn(label + ' 저장', function () {
              var next = String($('cfg-' + key).value || '').split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean).join('|');
              confirmWrite({ action: 'adm_ingest_cfg_set', target: key, title: label + ' 저장', okLabel: '저장',
                body: [diff([['이전', cur || '(비어 있음)'], ['이후', next || '(비어 있음)']])],
                payload: { key: key, value: next, expect: { value: cur } } });
            })
          ]);
        };
        box.appendChild(card('자동등록 설정', [
          mk('INGEST_SKIP_PROJECTS', '점검 대상 아닌 공사', '한 줄에 공사명 하나. 이미 만들어진 계획은 건드리지 않습니다.'),
          mk('INGEST_TEAM_ALIAS', '팀 별칭', '한 줄에 「표기=명부 팀」 하나.'),
          el('p', { 'class': 'adm-muted', text: '읽기 전용: ' + JSON.stringify(r.data.readonly) })
        ]));
      })
    ]);
  }
  function revertRow(it) {
    confirmWrite({ action: 'adm_ingest_revert_row', target: it.ingest_id, title: '이 자동등록 취소', okLabel: '계획 취소', danger: true,
      body: [diff([['원문', it.raw_company + ' · ' + it.raw_project + ' · ' + it.raw_owner], ['계획', it.plan_id + ' (' + it.planned_date + ')']]),
             el('p', { text: '계획을 취소합니다. 같은 메일이 다시 처리되지는 않습니다(종결).' })],
      payload: { ingest_id: it.ingest_id, expect: { g: it.revert.g } } });
  }
  function reviveRow(it) {
    confirmWrite({ action: 'adm_ingest_revive_row', target: it.ingest_id, title: '취소된 계획 되살리기', okLabel: '되살리기',
      body: [diff([['원문', it.raw_company + ' · ' + it.raw_project], ['계획', it.plan_id + ' (' + it.planned_date + ')']]), input('rv-reason', '사유(10자 이상)')],
      collect: function () { return { ingest_id: it.ingest_id, reason: val('rv-reason'), expect: { state: it.state } }; } });
  }
  function reprocessRow(it) {
    read('adm_ingest_reprocess_preview', { ingest_ids: [it.ingest_id] }).then(function (pv) {
      if (!pv || !pv.ok) { flash(errText(pv), 'err'); return; }
      if (!pv.data.count) {
        var why = (pv.data.skipped[0] || {}).why || '';
        flash(/processing|ALREADY_REQUESTED_TODAY/.test(why) ? '재처리 대기 중(이미 요청됨)' : (/NOT_TERMINAL/.test(why) ? '보류 중 — 자동 재시도됩니다' : '재처리 대상이 아닙니다: ' + why), 'warn');
        return;
      }
      confirmWrite({ action: 'adm_ingest_reprocess', target: it.ingest_id, title: '재처리 요청', okLabel: '재처리 요청',
        body: [el('p', { text: '다음 정기 실행(매일 10시대)에 다시 처리됩니다 — 이 버튼은 등록을 바로 하지 않습니다.' })],
        payload: { ingest_ids: [it.ingest_id] } });
    });
  }

  /* ---------- 탭: 공사/협력회사 ---------- */
  function viewMaster(main) {
    return Promise.all([read('adm_comp_list'), read('adm_proj_list')]).then(function (rs) {
      var c = rs[0], p = rs[1];
      if (!c || !c.ok) return failInto(main, c);
      if (!p || !p.ok) return failInto(main, p);
      main.appendChild(card('협력회사', [
        el('div', { 'class': 'adm-row' }, [input('cm-name', '새 회사 이름'), input('cm-alias', '별칭(쉼표 구분)'),
          btn('협력회사 추가', function () {
            var nm = val('cm-name'), al = val('cm-alias');
            confirmWrite({ action: 'adm_comp_add', target: 'new:' + nm, title: '협력회사 추가', okLabel: nm + ' 추가',
              body: [diff([['이름', nm], ['별칭', al || '-']]), el('p', { 'class': 'adm-muted', text: '회사 번호는 서버가 정합니다.' })],
              payload: { name: nm, alias: al } });
          })]),
        table(['ID', '이름', '별칭', '상태', '진행 공사', '예정 계획', ''], c.data.items.map(function (o) {
          var ex = { name: o.name, alias: o.alias.join(','), active: o.active ? 'true' : 'false' };
          return [o.company_id, o.name, o.alias.join(', '), o.active ? '활성' : '비활성', o.active_projects, o.planned, el('span', {}, [
            btn('이름 변경', function () {
              confirmWrite({ action: 'adm_comp_edit', target: o.company_id, title: o.name + ' 이름 변경', okLabel: '변경',
                body: [input('ce-name', '새 이름', { value: o.name }), el('p', { 'class': 'adm-muted', text: '옛 이름은 별칭으로 남습니다(보류 메일이 같은 회사로 매칭되게).' })],
                collect: function () { return { company_id: o.company_id, name: val('ce-name'), expect: ex }; } });
            }, 'ghost'),
            btn('별칭 추가', function () {
              confirmWrite({ action: 'adm_comp_edit', target: o.company_id, title: o.name + ' 별칭 추가', okLabel: '추가',
                body: [input('ce-alias', '추가할 별칭(쉼표 구분)'), el('p', { 'class': 'adm-muted', text: '별칭은 추가만 됩니다.' })],
                collect: function () { return { company_id: o.company_id, alias_add: val('ce-alias'), expect: ex }; } });
            }, 'ghost'),
            btn(o.active ? '비활성' : '활성', function () {
              confirmWrite({ action: 'adm_comp_edit', target: o.company_id, title: o.name + (o.active ? ' 비활성' : ' 활성'), okLabel: o.active ? '비활성으로' : '활성으로',
                danger: o.active, payload: { company_id: o.company_id, active: !o.active, expect: ex } });
            }, o.active ? 'danger' : 'ghost')
          ])];
        }))
      ]));
      var showDeleted = state.showDeleted;
      var items = p.data.items.filter(function (o) { return showDeleted || o.status !== '삭제'; });
      main.appendChild(card('공사 (' + items.length + ')', [
        el('label', {}, [el('input', { type: 'checkbox', id: 'pj-show-del', checked: showDeleted,
          onchange: function (e) { state.showDeleted = !!e.target.checked; refresh(); } }), ' 삭제(숨김) 공사도 보기']),
        table(['번호', '공사명', '회사', '상태', '계획(예정/완료/취소/미점검)', '제출', '부적합', ''], items.map(function (o) {
          var pl = o.plans;
          var acts = el('span', {}, []);
          var tr = function (action, label, extra, danger) {
            acts.appendChild(btn(label, function () {
              var body = [diff([['공사', o.name + ' (' + o.project_id + ')'], ['상태', o.status + ' → ' + label]])];
              if (action === 'adm_proj_delete') body.push(input('pj-reason', '삭제 사유(10자 이상)'), el('p', { 'class': 'adm-muted', text: '행은 지우지 않고 숨깁니다. 과거 기록은 그대로 남습니다.' }));
              confirmWrite({ action: action, target: o.project_id, title: '공사 ' + label, okLabel: o.name + ' ' + label, danger: danger, body: body,
                collect: function () { var q = { project_id: o.project_id, expect: { status: o.status } }; if (action === 'adm_proj_delete') q.reason = val('pj-reason'); return q; } });
            }, danger ? 'danger' : 'ghost'));
          };
          if (o.status === '진행') { tr('adm_proj_close', '완료'); tr('adm_proj_delete', '삭제', null, true); }
          else if (o.status === '완료') { tr('adm_proj_reopen', '재개'); tr('adm_proj_delete', '삭제', null, true); }
          else if (o.status === '삭제') tr('adm_proj_restore', '복원');
          acts.appendChild(btn('이름 수정', function () {
            confirmWrite({ action: 'adm_proj_edit', target: o.project_id, title: '공사명 수정', okLabel: '저장',
              body: [input('pj-name', '새 공사명(60자 이내)', { value: o.name }), el('p', { 'class': 'adm-muted', text: '과거 기록에 남은 이름은 바뀌지 않습니다.' })],
              collect: function () { return { project_id: o.project_id, name: val('pj-name'), expect: { name: o.name } }; } });
          }, 'ghost'));
          return [o.project_id, o.name, o.company_name, o.status, pl.planned + '/' + pl.done + '/' + pl.canceled + '/' + pl.unchecked, o.submissions, o.findings, acts];
        }))
      ]));
    });
  }

  /* ---------- 탭: 기록 정정 ---------- */
  function viewRecord(main) {
    main.appendChild(card('제출 조회·취소', [
      el('div', { 'class': 'adm-row' }, [input('rc-id', '제출 ID(submission_id)'), btn('조회', function () {
        var id = val('rc-id');
        read('adm_sub_lookup', { submission_id: id }).then(function (r) {
          var box = $('rc-out'); box.textContent = '';
          if (!r || !r.ok) { box.appendChild(msgBox(errText(r), 'err')); return; }
          var d = r.data;
          box.appendChild(diff([['점검일', d.inspect_date], ['공사', d.company_name + ' · ' + d.project_name], ['점검자', d.inspector_name],
            ['상태', d.status], ['부적합', d.findings_open + ' / ' + d.findings_total + '(미취소/전체)'],
            ['PDF 발송', d.pull_count + '회' + (d.pull_to.length ? ' — ' + d.pull_to.join(', ') : '')]]));
          if (d.pull_count) box.appendChild(msgBox('이미 ' + d.pull_count + '곳으로 발송됨 — 회수 불가, 정정 연락이 필요합니다', 'warn'));
          if (d.status !== 'voided' || d.findings_open > 0) {
            box.appendChild(btn('이 제출 취소', function () {
              confirmWrite({ action: 'adm_sub_void', target: d.submission_id, title: '제출 취소', okLabel: '제출 취소', danger: true,
                body: [diff([['제출', d.submission_id], ['공사', d.project_name + ' ' + d.inspect_date]]), input('rc-reason', '사유(10자 이상)')],
                collect: function () { return { submission_id: d.submission_id, reason: val('rc-reason'), expect: { status: d.status, findings_sig: d.findings_sig } }; } });
            }, 'danger'));
          }
        });
      })]),
      el('div', { id: 'rc-out' })
    ]));
    return Promise.resolve();
  }

  /* ---------- 탭: 상태/이력 ---------- */
  var auditCursor = null;
  function viewOps(main) {
    return read('adm_status').then(function (r) {
      if (!r || !r.ok) return failInto(main, r);
      var d = r.data;
      var unk = function (v) { return v == null ? '확인 불가' : v; };
      main.appendChild(card('상태', [
        diff([['코드 지문', d.code_rev], ['시간대', d.tz + ' (오늘 ' + d.server_today + ')'], ['트리거', d.triggers == null ? '확인 불가' : JSON.stringify(d.triggers)],
          ['자동등록 마지막 실행', d.ingest_last ? d.ingest_last.date + ' ' + d.ingest_last.phase : '확인 불가'],
          ['최근 백업 / 월간 보관', unk(d.backup_latest) + ' / ' + unk(d.archive_latest)], ['앱 오류(7일)', unk(d.app_errors_7d)],
          ['PIN 저장', d.pin_storage ? '해시 ' + d.pin_storage.hashed + ' · 평문 ' + d.pin_storage.plain : '확인 불가'],
          ['확인 필요 요청', d.unknown_requests]]),
        btn('복원 점검(10분에 1회, 수십 초 걸림)', function () {
          flash('복원 점검 중…', '');
          read('adm_restore_check').then(function (x) { flash(x && x.ok ? '복원 점검: ' + JSON.stringify(x.data) : errText(x), x && x.ok ? 'ok' : 'err'); });
        }, 'ghost')
      ]));
      var auditBox = el('div', {});
      main.appendChild(card('관리 이력', [
        el('div', { 'class': 'adm-row' }, [input('au-target', '대상'), input('au-actor', '행위자'), btn('조회', function () { auditCursor = null; loadAudit(auditBox, false); }, 'ghost')]),
        auditBox
      ]));
      return loadAudit(auditBox, false);
    });
  }
  function loadAudit(box, more) {
    var q = { days: 90, target: val('au-target'), actor: val('au-actor') };
    if (more && auditCursor) q.cursor = auditCursor;
    return read('adm_audit_list', q).then(function (r) {
      if (!more) box.textContent = '';
      if (!r || !r.ok) { box.appendChild(msgBox(errText(r), 'err')); return; }
      auditCursor = r.data.cursor;
      if (!r.data.items.length && !more) box.appendChild(msgBox('이력이 없습니다', ''));
      box.appendChild(table(['시각', '행위자', '대상', '동작', '필드', '이전', '이후'], r.data.items.map(function (o) {
        return [o.changed_at, o.actor, o.target_name || o.target_id, o.action, o.field, o.before.slice(0, 80), o.after.slice(0, 120)];
      })));
      if (auditCursor) box.appendChild(btn('더 보기', function () { loadAudit(box, true); }, 'ghost'));
    });
  }

  /* ---------- 탭: 확인 필요 ---------- */
  function viewReqs(main) {
    return read('adm_req_list').then(function (r) {
      if (!r || !r.ok) return failInto(main, r);
      var items = r.data.items;
      if (!items.length) { main.appendChild(card('확인 필요', [msgBox('확인이 필요한 요청이 없습니다', 'ok')])); return; }
      main.appendChild(card('확인 필요 (' + items.length + ')', [
        el('p', { 'class': 'adm-muted', text: '결과를 확정하지 못한 요청입니다. 실제 화면·시트를 확인한 뒤 골라 닫으세요.' }),
        table(['요청', '대상', '행위자', '시각', ''], items.map(function (o) {
          var acts = el('span', {}, []);
          if (state.roles.indexOf('*') < 0) {
            acts.appendChild(el('span', { 'class': 'adm-muted', text: '소유자(전체 권한)에게 확인을 요청하세요' }));
            return [o.action, o.target, o.actor, o.at, acts];
          }
          var close = function (outcome, label) {
            acts.appendChild(btn(label, function () {
              var body = [diff([['요청', o.action + ' · ' + o.target], ['처리', label]])];
              if (outcome === 'partial') body.push(input('rq-note', '설명(10자 이상)'));
              confirmWrite({ action: 'adm_req_resolve', target: 'resolve:' + o.req_id, title: '확인 필요 닫기', okLabel: label, body: body,
                collect: function () { var q = { resolves: o.req_id, outcome: outcome }; if (outcome === 'partial') q.note = val('rq-note'); return q; } });
            }, 'ghost'));
          };
          close('applied', '적용됨');
          close('not_applied', '적용 안 됨');
          close('partial', '일부만');
          if (o.converge) close('converge', '다시 실행으로 마무리');
          return [o.action, o.target, o.actor, o.at, acts];
        }))
      ]));
    });
  }

  var VIEWS = { roster: viewRoster, ingest: viewIngest, master: viewMaster, record: viewRecord, ops: viewOps, reqs: viewReqs };

  /* ---------- 서비스워커 확인 문턱(설계 §9 4단계, Codex P6-R2-01) ----------
     불변식(Codex P6-R7-01): 「이 페이지 묶음의 버전(config.js 의 APP_VER — admin.html 이 ?v= 로 고정해 부른다)」 ==
     「지금 이 탭을 맡은 워커의 버전(CACHE)」 일 때만 연다. 어느 워커가 HTML 을 내줬는지는 증명할 수 없지만,
     옛 캐시에서 나온 페이지라면 그 APP_VER 가 옛 값이라 최신 워커의 버전과 어긋난다 → update·새로고침 경로.
     c0(스크립트 실행 시점의 워커)와 다른 워커로 바뀐 경우의 1회 새로고침은 그 위의 추가 방어다.
     옛 SW(관리 파일 network-only 규칙이 없는 버전)가 이 탭을 맡고 있으면 관리 화면을 열지 않는다.
     - SW 미지원 → 그대로 연다(옛 캐시 문제 자체가 없다)
     - 등록 없음 → register → controller 를 기다린다
     - controller 의 버전(CACHE 이름)이 이 페이지의 APP_VER 와 다르면 update → controllerchange → 새로고침(한 번)
     - 각 단계 10초. 실패·시간 초과면 갱신 실패 화면. 확인 전에는 「화면 갱신 중」만 보이고 쓰기 화면을 그리지 않는다. */
  /* 자동 새로고침 시도 표시 — 파일 묶음 복구와 워커 갱신을 따로 센다(한쪽이 다른 쪽의 기회를 쓰지 않게, Codex P6-R9-01).
     실패 화면을 띄울 때 지운다: 자동 새로고침은 각 1회뿐이지만, 사람이 새로고침하면 다시 시도할 수 있어야 한다. */
  var SW_WAIT_MS = 10000, SW_RELOAD_FLAG = 'safety_admin_sw_reload', BUNDLE_RELOAD_FLAG = 'safety_admin_bundle_reload';
  function swExpected() { return 'safety-checklist-v' + String((window.CONFIG && CONFIG.APP_VER) || ''); }
  function withTimeout(p, ms) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error('timeout')); }, ms);
      p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
  }
  function swAskVersion(ctrl) {
    return new Promise(function (resolve) {
      var ch;
      try { ch = new MessageChannel(); } catch (e) { resolve(''); return; }
      var t = setTimeout(function () { resolve(''); }, 2000);   // 옛 SW 는 답하지 않는다 → 옛 버전으로 본다
      ch.port1.onmessage = function (ev) { clearTimeout(t); resolve(String((ev && ev.data && ev.data.ver) || '')); };
      try { ctrl.postMessage({ type: 'adm-sw-ver' }, [ch.port2]); } catch (e2) { clearTimeout(t); resolve(''); }
    });
  }
  function swWaitController(sw) {
    return new Promise(function (resolve) {
      if (sw.controller) { resolve(sw.controller); return; }
      sw.addEventListener('controllerchange', function () { resolve(sw.controller); });
    });
  }
  /* controllerchange 는 질의 중에도 올 수 있다 — 감시를 맨 먼저 시작하고, 이미 바뀌었으면 기다리지 않는다(Codex P6-R3-03). */
  var swChanged = false, swWaiters = [];
  function swWatch(sw) {
    sw.addEventListener('controllerchange', function () { swChanged = true; swWaiters.splice(0).forEach(function (f) { f(); }); });
  }
  function swNextChange() { return swChanged ? Promise.resolve() : new Promise(function (r) { swWaiters.push(r); }); }
  function swGate() {
    var sw = navigator.serviceWorker;
    if (!sw || !sw.getRegistration) return Promise.resolve('ok');
    swWatch(sw);
    var c0 = sw.controller;                                   // 이 페이지를 받을 때 맡고 있던 워커(Codex P6-R6-01)
    return withTimeout(sw.getRegistration(), SW_WAIT_MS).then(function (reg) {
      if (!reg) {
        return withTimeout(sw.register('./sw.js'), SW_WAIT_MS)
          .then(function (r2) { return withTimeout(swWaitController(sw), SW_WAIT_MS).then(function (c) { return swCheck(sw, r2 || reg, c, c0); }); });
      }
      var ctrl = sw.controller;
      if (!ctrl) {
        /* 등록은 있는데 이 탭을 맡은 워커가 없다(강력 새로고침 등) — 갱신을 걸고 맡을 때까지 기다린다 */
        try { reg.update(); } catch (e) { /* 아래 시간 제한이 판단한다 */ }
        return withTimeout(swWaitController(sw), SW_WAIT_MS).then(function (c) { return swCheck(sw, reg, c, c0); });
      }
      return swCheck(sw, reg, ctrl, c0);
    }).catch(function () { return 'fail'; });
  }
  /** 워커 c 에게 묻고 판단한다 — 모든 분기 공통(Codex P6-R4-01·R5-01).
      질의 중에 이 탭을 맡은 워커가 바뀌었으면 c 의 답(일치하더라도)은 믿지 않고, 지금 워커에게 다시 묻는다.
      지금 워커가 최신이어도 이 페이지는 그 전환 이전에 받은 것이므로 새로고침한다. */
  function swCheck(sw, reg, c, c0) {
    return swAskVersion(c).then(function (v) {
      var now = sw.controller;
      if (now !== c) {
        if (!now) return swRefresh(sw, reg);
        return swAskVersion(now).then(function (v2) { return v2 === swExpected() ? swReload() : swRefresh(sw, reg); });
      }
      if (v !== swExpected()) return swRefresh(sw, reg);
      /* 지금 워커가 최신이어도, 페이지를 받을 때 다른 워커가 맡고 있었다면 그 워커가 준 페이지다 — 1회 새로고침.
         처음에 워커가 없었다면(c0 없음) 페이지는 네트워크에서 왔으므로 그대로 연다. */
      return (c0 && now !== c0) ? swReload() : 'ok';
    });
  }
  /** 자동 새로고침 1회. 표시를 적고 다시 읽어 확인된 때만 새로고침한다 — 저장이 안 되는 브라우저(사생활 보호·용량)
      에서는 다음 로딩도 표시가 없어 끝없이 새로고침하게 된다(Codex P6-R10-01). 확인 못 하면 false. */
  function autoReloadOnce(flag) {
    if (sget('session', flag)) return false;
    sset('session', flag, '1');
    if (sget('session', flag) !== '1') return false;
    window.location.reload();
    return true;
  }
  function swReload() {
    return autoReloadOnce(SW_RELOAD_FLAG) ? 'reload' : 'fail';   // 이미 한 번 했거나 표시를 못 남기면 실패 화면
  }
  function swRefresh(sw, reg) {
    if (sget('session', SW_RELOAD_FLAG)) return 'fail';
    if (!reg || !reg.update) return 'fail';
    if (swChanged) return swReload();                        // 이미 전환됨 — 추가 이벤트를 기다리지 않는다
    return withTimeout(reg.update(), SW_WAIT_MS).then(function () { return withTimeout(swNextChange(), SW_WAIT_MS); })
      .then(function () { return swReload(); });
  }
  /** 페이지 묶음 일치 — HTML·admin.js·config.js 가 같은 빌드인지(Codex P6-R8-01). HTTP 캐시가 옛 admin.js 를
      섞어 주면 여기서 걸린다. 셋이 같아야 「묶음 버전」이 정의되고, 그 값을 워커 버전과 대조한다(swExpected). */
  function bundleOk() {
    var m = $('adm-build');
    var html = m ? String(m.getAttribute('content') || '') : '';
    var cfg = String((window.CONFIG && CONFIG.APP_VER) || '');
    return !!cfg && html === cfg && ADMIN_BUILD === cfg;
  }
  function boot() {
    ['adm-key-view', 'adm-login-view', 'adm-tabs', 'adm-logout'].forEach(function (id) { $(id).hidden = true; });
    flash('화면 갱신 중…', '');
    if (!bundleOk()) {
      if (autoReloadOnce(BUNDLE_RELOAD_FLAG)) return;
      sset('session', BUNDLE_RELOAD_FLAG, '');
      flash('화면을 갱신하지 못했습니다(파일 버전이 섞여 있음) — 새로고침하거나 다른 브라우저로 여세요', 'err');
      return;
    }
    sset('session', BUNDLE_RELOAD_FLAG, '');
    swGate().then(function (st) {
      if (st === 'reload') return;
      if (st !== 'ok') {
        sset('session', SW_RELOAD_FLAG, '');
        flash('화면을 갱신하지 못했습니다 — 새로고침하거나 다른 브라우저로 여세요', 'err');
        return;
      }
      sset('session', SW_RELOAD_FLAG, '');
      flash('', '');
      route();
    });
  }
  boot();
})();
