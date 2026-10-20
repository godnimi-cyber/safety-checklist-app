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
  var ADMIN_BUILD = '0.5.5-c1415bd2';                  // tools/stamp_web_version.py 가 찍는다 — 손으로 고치지 않는다

  var state = { key: '', sid: '', who: null, roles: [], tab: '', gen: 0, viewGen: 0, showDeleted: false };
  var NEVER = function () { return new Promise(function () { /* 버린 응답 — 콜백을 부르지 않는다 */ }); };

  /* 2026-10-19 사용자 지시 — 관리자 페이지는 네 가지만: ①점검자 등록/삭제 ②협력회사 등록/삭제
     ③자동등록 보류 정리(보류 종결) ④등록된 공사 수정/삭제. 「확인 필요」는 결과를 모르는 요청이 대상을 잠그는
     안전장치라 남긴다(없애면 잠긴 대상을 풀 길이 없다). 서버의 다른 관리 동작은 그대로 두고 화면에서만 뺐다. */
  var TABS = [
    { id: 'roster', label: '점검자', role: 'roster' },
    { id: 'company', label: '협력회사', role: 'master' },
    { id: 'project', label: '공사', role: 'master' },
    { id: 'ingest', label: '자동등록 보류', role: 'ingest' },
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
    REASON_REQUIRED: '사유를 10자 이상 적어 주세요', NOT_HELD: '이미 보류가 아닙니다 — 다시 불러오세요', MAIL_LEVEL_HOLD: '메일 단위 보류는 종결할 수 없습니다 — 자동 재시도됩니다', PIN_FORMAT: '새 PIN 은 숫자 4자리입니다',
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
  /* card(제목, 내용, 머리 오른쪽 버튼들, 강조) — 머리 버튼은 제목 줄 오른쪽에 붙인다. */
  function card(title, kids, head, attn) {
    var h = head && head.length ? el('div', { 'class': 'adm-card-head' }, [el('h2', { text: title }), el('div', { 'class': 'adm-acts' }, head)])
                                : el('h2', { text: title });
    return el('section', { 'class': 'adm-card' + (attn ? ' attn' : '') }, [h].concat(kids || []));
  }
  /* 동작 버튼 묶음 — 위험 버튼(danger-ghost)은 항상 맨 뒤로 보낸다. */
  function acts(list) {
    var safe = [], risky = [];
    (list || []).forEach(function (b) { if (b) (/\bdanger/.test(b.getAttribute ? (b.getAttribute('class') || '') : '') ? risky : safe).push(b); });
    return el('div', { 'class': 'adm-acts' }, safe.concat(risky));
  }
  function sbtn(label, fn, cls) { return btn(label, fn, 'sm ' + (cls || 'ghost')); }
  /* 머리글이 '' 인 칸 = 동작 칸(오른쪽 정렬·좁은 화면에서 카드 아래). nowrap: 줄바꿈하지 않을 칸 번호들. */
  function table(cols, rows, nowrap) {
    nowrap = nowrap || [];
    return el('div', { 'class': 'adm-tablewrap' }, [el('table', { 'class': 'adm-table' }, [
      el('thead', {}, [el('tr', {}, cols.map(function (c) { return el('th', { text: c }); }))]),
      el('tbody', {}, rows.map(function (r) {
        return el('tr', {}, r.map(function (c, i) {
          var cls = cols[i] === '' ? 'adm-td-acts' : (nowrap.indexOf(i) >= 0 ? 'adm-td-nowrap' : null);
          return el('td', { 'data-label': cols[i] || '', 'class': cls }, [c == null ? '' : (typeof c === 'object' ? c : String(c))]);
        }));
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
    PIN_FORMAT: ['pi-new', 'rs-newpin', 'ri-pin'], REASON_REQUIRED: ['rc-reason', 'pj-reason', 'rv-reason', 'dh-reason'], NOTE_REQUIRED: ['rq-note'],
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
        $('adm-who').textContent = (r.data.name || '') + '(' + r.data.real_id + ') · ' + (state.roles.indexOf('*') >= 0 ? '전체 권한' : '역할 ' + state.roles.join(','));
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

  /* ---------- ① 점검자 등록/삭제 ---------- */
  function viewRoster(main) {
    return read('adm_insp_list').then(function (r) {
      if (!r || !r.ok) return failInto(main, r);
      var items = r.data.items || [];
      main.appendChild(card('점검자 등록', [
        el('div', { 'class': 'adm-form-grid' }, [input('ri-id', '사번'), input('ri-team', '팀'), input('ri-name', '이름'),
          input('ri-display', '표시 이름(선택)'), input('ri-email', '이메일'), input('ri-pin', '처음 PIN(숫자 4자리)', { type: 'password', inputmode: 'numeric' })]),
        el('div', { 'class': 'adm-actions' }, [btn('점검자 등록', function () {
          var p = { inspector_id: val('ri-id'), team: val('ri-team'), name: val('ri-name'), display: val('ri-display'), email: val('ri-email') };
          var np = String($('ri-pin').value || '');
          /* 서버 필수값(사번·팀·이름·이메일·PIN)을 확인 창 전에 본다 — 폼은 확인 창 밖이라 서버 오류로는 고칠 칸을 가리킬 수 없다(Codex P8-R1). */
          var need = [['ri-id', '사번'], ['ri-team', '팀'], ['ri-name', '이름'], ['ri-email', '이메일'], ['ri-pin', '처음 PIN']];
          need.forEach(function (f) { var n = $(f[0]); if (n) n.removeAttribute('aria-invalid'); });
          var miss = need.filter(function (f) { return f[0] === 'ri-pin' ? !/^\d{4}$/.test(np) : !val(f[0]); });
          if (miss.length) {
            miss.forEach(function (f) { var n = $(f[0]); if (n) n.setAttribute('aria-invalid', 'true'); });
            var first = $(miss[0][0]); if (first && first.focus) first.focus();
            flash('입력하세요: ' + miss.map(function (f) { return f[1] + (f[0] === 'ri-pin' ? '(숫자 4자리)' : ''); }).join(', '), 'err');
            return;
          }
          confirmWrite({ action: 'adm_insp_add', target: p.inspector_id, title: '점검자 등록', okLabel: p.name + '(' + p.inspector_id + ') 등록',
            body: [diff([['사번', p.inspector_id], ['팀', p.team], ['이름', p.name], ['표시', p.display || '-'], ['이메일', p.email || '-']]),
                   el('p', { 'class': 'adm-muted', text: '처음 PIN 은 본인에게 직접 전달하세요. 점검자 앱은 다시 실행해야 새 명부를 받습니다.' })],
            collect: function () { p.new_pin = np; return p; } });
        })])
      ]));
      var act = items.filter(function (o) { return o.active; });
      main.appendChild(card('점검자 ' + act.length + '명', [
        act.length ? table(['사번', '이름', '팀', ''], act.map(function (o) {
          var a = o.is_admin ? acts([el('span', { 'class': 'adm-chip', style: 'white-space:nowrap', title: '관리자 계정은 Apps Script 편집기(ADMIN_ACL)에서만 바꿉니다', text: '관리자' })])
                             : acts([sbtn('삭제', function () { retireInsp(o); }, 'danger-ghost')]);
          return [o.inspector_id, o.name + (o.display && o.display !== o.name ? ' / ' + o.display : ''), o.team, a];
        }), [0, 2]) : msgBox('등록된 점검자가 없습니다', ''),
        items.length > act.length ? el('p', { 'class': 'adm-muted', text: '삭제(퇴사 처리)된 점검자 ' + (items.length - act.length) + '명은 목록에서 뺐습니다 — 과거 점검 기록은 그대로 남습니다.' }) : null
      ]));
    });
  }
  function retireInsp(o) {
    var cb = el('input', { type: 'checkbox', id: 'rt-confirm' });
    confirmWrite({ action: 'adm_insp_retire', target: o.inspector_id, title: '점검자 삭제(퇴사 처리)', okLabel: o.name + '(' + o.inspector_id + ') 삭제', danger: true,
      body: [el('p', { text: '명부에서 비활성으로 바꾸고 앱 접속을 끊습니다. 과거 점검 기록은 지우지 않습니다. 그 폰에 아직 안 보낸 기록이 있으면 더 보낼 수 없습니다.' }),
             el('p', { 'class': 'adm-muted', text: '이 화면에서는 되돌릴 수 없고, 같은 사번으로 다시 등록할 수도 없습니다. 실수로 삭제했으면 시스템 담당에게 재활성화(adm_insp_reactivate)를 요청하세요.' }),
             el('label', { 'class': 'adm-check' }, [cb, '그 점검자 폰에 미전송 기록이 없음을 확인했습니다'])],
      collect: function () { return { real_id: o.inspector_id, confirm_queue_empty: !!$('rt-confirm').checked }; } });
  }

  /* ---------- ② 협력회사 등록/삭제 ---------- */
  function viewCompany(main) {
    return read('adm_comp_list').then(function (c) {
      if (!c || !c.ok) return failInto(main, c);
      main.appendChild(card('협력회사 등록', [
        el('div', { 'class': 'adm-row' }, [input('cm-name', '회사 이름'), input('cm-alias', '별칭(선택, 쉼표 구분)'),
          btn('협력회사 등록', function () {
            var nm = val('cm-name'), al = val('cm-alias');
            confirmWrite({ action: 'adm_comp_add', target: 'new:' + nm, title: '협력회사 등록', okLabel: nm + ' 등록',
              body: [diff([['이름', nm], ['별칭', al || '-']]), el('p', { 'class': 'adm-muted', text: '회사 번호는 서버가 정합니다. 별칭은 자동등록 메일의 시공사 표기와 맞추는 데 씁니다.' })],
              payload: { name: nm, alias: al } });
          })])
      ]));
      var items = c.data.items || [];
      var on = items.filter(function (o) { return o.active; }), off = items.filter(function (o) { return !o.active; });
      var row = function (o) {
        var ex = { name: o.name, alias: o.alias.join(','), active: o.active ? 'true' : 'false' };
        var b = o.active
          ? sbtn('삭제', function () {
              confirmWrite({ action: 'adm_comp_edit', target: o.company_id, title: o.name + ' 삭제', okLabel: o.name + ' 삭제', danger: true,
                body: [diff([['회사', o.name + ' (' + o.company_id + ')'], ['진행 공사 / 예정 계획', o.active_projects + ' / ' + o.planned]]),
                       el('p', { text: '비활성으로 바꿔 목록·자동등록 매칭에서 뺍니다. 과거 기록은 지우지 않고, 아래 「삭제한 협력회사」에서 되돌릴 수 있습니다.' })],
                payload: { company_id: o.company_id, active: false, expect: ex } });
            }, 'danger-ghost')
          : sbtn('되돌리기', function () {
              confirmWrite({ action: 'adm_comp_edit', target: o.company_id, title: o.name + ' 되돌리기', okLabel: o.name + ' 다시 사용',
                payload: { company_id: o.company_id, active: true, expect: ex } });
            });
        return [o.company_id, o.name, o.alias.join(', ') || '-', o.active_projects, acts([b])];
      };
      main.appendChild(card('협력회사 ' + on.length + '곳', [
        on.length ? table(['번호', '이름', '별칭', '진행 공사', ''], on.map(row), [0]) : msgBox('등록된 협력회사가 없습니다', ''),
        off.length ? el('h3', { text: '삭제한 협력회사 ' + off.length + '곳' }) : null,
        off.length ? table(['번호', '이름', '별칭', '진행 공사', ''], off.map(row), [0]) : null
      ]));
    });
  }

  /* ---------- ④ 등록된 공사 수정/삭제 ---------- */
  function viewProject(main) {
    return read('adm_proj_list').then(function (p) {
      if (!p || !p.ok) return failInto(main, p);
      var showDeleted = state.showDeleted;
      var items = p.data.items.filter(function (o) { return showDeleted || o.status !== '삭제'; });
      main.appendChild(card('공사 ' + items.length + '건', [
        el('label', { 'class': 'adm-check' }, [el('input', { type: 'checkbox', id: 'pj-show-del', checked: showDeleted,
          onchange: function (e) { state.showDeleted = !!e.target.checked; refresh(); } }), '삭제한 공사도 보기(되돌리기)']),
        table(['번호', '공사명', '회사', '상태', '예정 계획', ''], items.map(function (o) {
          var list = [];
          if (o.status === '삭제') {
            list.push(sbtn('복원', function () {
              confirmWrite({ action: 'adm_proj_restore', target: o.project_id, title: '공사 복원', okLabel: o.name + ' 복원',
                body: [diff([['공사', o.name + ' (' + o.project_id + ')']])],
                collect: function () { return { project_id: o.project_id, expect: { status: o.status } }; } });
            }));
          } else {
            list.push(sbtn('수정', function () {
              confirmWrite({ action: 'adm_proj_edit', target: o.project_id, title: '공사명 수정', okLabel: '저장',
                body: [input('pj-name', '새 공사명(60자 이내)', { value: o.name }), el('p', { 'class': 'adm-muted', text: '과거 기록에 남은 이름은 바뀌지 않습니다.' })],
                collect: function () { return { project_id: o.project_id, name: val('pj-name'), expect: { name: o.name } }; } });
            }));
            list.push(sbtn('삭제', function () {
              confirmWrite({ action: 'adm_proj_delete', target: o.project_id, title: '공사 삭제', okLabel: o.name + ' 삭제', danger: true,
                body: [diff([['공사', o.name + ' (' + o.project_id + ')'], ['예정 계획', String(o.plans.planned)]]), input('pj-reason', '삭제 사유(10자 이상)'),
                       el('p', { 'class': 'adm-muted', text: '행은 지우지 않고 숨깁니다. 과거 기록은 그대로 남고, 「삭제한 공사도 보기」에서 복원할 수 있습니다.' })],
                collect: function () { return { project_id: o.project_id, expect: { status: o.status }, reason: val('pj-reason') }; } });
            }, 'danger-ghost'));
          }
          return [o.project_id, o.name, o.company_name, o.status, o.plans.planned, acts(list)];
        }), [0, 3])
      ]));
    });
  }

  /* ---------- ③ 자동등록 보류 정리 ---------- */
  function viewIngest(main) {
    return read('adm_ingest_status').then(function (r) {
      if (!r || !r.ok) return failInto(main, r);
      var d = r.data;
      main.appendChild(card('보류 ' + d.held.length + '건' + (d.running ? ' — 자동등록 지금 실행 중' : ''), [
        d.held.length ? el('p', { 'class': 'adm-muted', text: '보류가 남은 메일은 실행할 때마다 통째로 다시 처리되어, 요약 메일의 건너뜀·멱등·보류 건수가 매일 같은 숫자로 다시 나옵니다. ' +
          '담당자를 명부에 넣으면 다음 실행에 자동 등록되고, 등록하지 않을 행은 「보류 종결」하면 그 메일이 더는 처리되지 않아 다음 요약부터 빠집니다.' }) : null,
        d.held.length ? table(['처리일', '원문(회사 · 공사 · 담당)', '사유', ''], d.held.map(function (h) {
          if (/#0$/.test(h.ingest_id)) return [h.batch_date, h.raw_company + ' · ' + h.raw_project + ' · ' + h.raw_owner, h.reason,
                  acts([el('span', { 'class': 'adm-muted', text: '메일 단위 보류 — 다음 실행에 자동 재시도' })])];
          return [h.batch_date, h.raw_company + ' · ' + h.raw_project + ' · ' + h.raw_owner, h.reason,
                  acts([sbtn('보류 종결', function () { dismissHeld({ ingest_id: h.ingest_id, raw_company: h.raw_company, raw_project: h.raw_project, raw_owner: h.raw_owner, reason: h.reason, dismiss: { ok: true, g: h.g } }); }, 'danger-ghost')])];
        }), [0]) : msgBox('보류된 행이 없습니다 — 요약 메일에 반복 집계되는 건수가 없습니다', 'ok'),
        (d.dismissed || []).length ? el('h3', { text: '종결한 보류 ' + d.dismissed.length + '건(최근 순)' }) : null,
        (d.dismissed || []).length ? table(['종결 시각', '원문(회사 · 공사 · 담당)', ''], d.dismissed.map(function (h) {
          return [h.at, h.raw_company + ' · ' + h.raw_project + ' · ' + h.raw_owner,
                  acts([sbtn('되돌리기', function () { reprocessRow({ ingest_id: h.ingest_id }); })])];
        }), [0]) : null
      ], null, d.held.length > 0));
    });
  }
  function dismissHeld(it) {
    confirmWrite({ action: 'adm_ingest_dismiss_held', target: it.ingest_id, title: '보류 종결', okLabel: '보류 종결', danger: true,
      body: [diff([['원문', it.raw_company + ' · ' + it.raw_project + ' · ' + it.raw_owner], ['보류 사유', it.reason || it.why || '-']]),
             el('p', { text: '이 행을 더 기다리지 않고 거절로 닫습니다. 계획은 만들지 않고, 협력회사로 메일을 보내지 않습니다. 이 메일에 다른 보류가 없으면 다음 실행부터 다시 처리하지 않습니다.' }),
             el('p', { 'class': 'adm-muted', text: '되돌리려면 아래 「종결한 보류」에서 「되돌리기」를 누르세요(다음 정기 실행에 다시 처리).' }),
             input('dh-reason', '사유(10자 이상)')],
      collect: function () { return { ingest_id: it.ingest_id, reason: val('dh-reason'), expect: { g: it.dismiss.g } }; } });
  }
  function reprocessRow(it) {
    read('adm_ingest_reprocess_preview', { ingest_ids: [it.ingest_id] }).then(function (pv) {
      if (!pv || !pv.ok) { flash(errText(pv), 'err'); return; }
      if (!pv.data.count) {
        var why = (pv.data.skipped[0] || {}).why || '';
        flash(/processing|ALREADY_REQUESTED_TODAY/.test(why) ? '재처리 대기 중(이미 요청됨)' : (/NOT_TERMINAL/.test(why) ? '보류 중 — 자동 재시도됩니다' : '되돌릴 수 없습니다: ' + why), 'warn');
        return;
      }
      confirmWrite({ action: 'adm_ingest_reprocess', target: it.ingest_id, title: '보류 종결 되돌리기', okLabel: '되돌리기',
        body: [el('p', { text: '다음 정기 실행(매일 10시대)에 이 행을 다시 처리합니다 — 담당자가 여전히 명부에 없으면 다시 보류됩니다.' })],
        payload: { ingest_ids: [it.ingest_id] } });
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
          if (state.roles.indexOf('*') < 0) {
            return [o.action, o.target, o.actor, o.at, acts([el('span', { 'class': 'adm-muted', text: '전체 권한 관리자에게 확인을 요청하세요' })])];
          }
          var list = [];
          var close = function (outcome, label) {
            list.push(sbtn(label, function () {
              var body = [diff([['요청', o.action + ' · ' + o.target], ['처리', label]])];
              if (outcome === 'partial') body.push(input('rq-note', '설명(10자 이상)'));
              confirmWrite({ action: 'adm_req_resolve', target: 'resolve:' + o.req_id, title: '확인 필요 닫기', okLabel: label, body: body,
                collect: function () { var q = { resolves: o.req_id, outcome: outcome }; if (outcome === 'partial') q.note = val('rq-note'); return q; } });
            }));
          };
          close('applied', '적용됨');
          close('not_applied', '적용 안 됨');
          close('partial', '일부만');
          if (o.converge) close('converge', '다시 실행으로 마무리');
          return [o.action, o.target, o.actor, o.at, acts(list)];
        }))
      ]));
    });
  }

  var VIEWS = { roster: viewRoster, company: viewCompany, project: viewProject, ingest: viewIngest, reqs: viewReqs };

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
