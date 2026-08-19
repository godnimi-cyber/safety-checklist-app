/* dashboard.js — 웹 대시보드 (스펙 docs/superpowers/specs/2026-08-07-web-dashboard-design.md rev.3)
 * ES5 · 제로 의존성 · app.js 를 로드하지 않는 독립 페이지.
 * CONFIG 는 API_URL 만 쓴다 — SHARED_KEY 는 절대 읽지 않는다(스펙 §7). */
(function () {
  'use strict';

  var KEY_STORE = 'safety_dash_key';
  var THEME_STORE = 'safety_dash_theme';
  var PAYLOAD_STORE = 'safety_dash_last';

  /* ---------- 마지막 화면 저장(체감 로딩 제거, 2026-08-10) ----------
     병목은 GAS 왕복(콜드스타트 포함 수 초)이다 — 그동안 빈 화면 대신 직전 커밋 화면을
     먼저 보인다. 기준 시각 표기가 그대로 남아 낡음을 숨기지 않고, 키와 같은 기기
     저장이므로 열람 경계도 동일하다(키 지우기가 함께 지운다). */
  function persistLast_(payload) {
    try { localStorage.setItem(PAYLOAD_STORE, JSON.stringify({ v: 1, payload: payload })); }
    catch (e) { /* 용량·프라이빗 모드 — 저장 실패는 기능 저하가 아니다 */ }
  }

  /** 저장본 복원 — 형식이 다르거나 깨졌으면 null(그냥 기존 로딩 화면). */
  function restoreLast_() {
    try {
      var o = JSON.parse(localStorage.getItem(PAYLOAD_STORE) || 'null');
      if (!o || o.v !== 1 || !o.payload || !o.payload.range) return null;
      return o.payload;
    } catch (e) { return null; }
  }

  /* ---------- 상태 (스펙 §4.1) ----------
     렌더·CSV 는 payload·committedRange 만 본다. gen 은 요청 세대 — 최신 세대가 아닌
     응답은 도착해도 버린다(늦은 응답 역전·키 삭제 후 부활 방지).
     view: null=전체, 문자열=팀 name(빈 문자열 '(팀 없음)' 포함 — null 과 '' 는 다르다). */
  /* serverOk: **이 키로 서버 조회가 실제로 성공한 적이 있는가.** 저장본 복원(restoreLast_)은
     서버를 부르지 않으므로 payload 만으로는 알 수 없다. 쓰기가 AUTH 로 거절됐을 때
     "키가 틀렸다" 와 "서버가 그 action 을 아직 모른다" 를 가르는 데 쓴다(아래 odAuthFail_). */
  var state = { key: '', gen: 0, payload: null, committedRange: null, view: null, serverOk: false };

  /* ---------- 순수 상태 전이 (DOM 없음 — dashboard-web.test.mjs 조각 평가 대상) ---------- */

  /** 조회 시작: 세대를 올리고 그 번호를 돌려준다. 응답 적용 때 대조한다. */
  function beginQuery_(st) {
    st.gen += 1;
    return st.gen;
  }

  /** data.teams 에서 name 이 정확히 일치하는 팀. 없으면 null. */
  function findTeam_(data, name) {
    var ts = (data && data.teams) || [];
    for (var i = 0; i < ts.length; i++) if (ts[i].name === name) return ts[i];
    return null;
  }

  /** 응답 적용 — 'stale'|'committed'|'auth'|'config'|'transient'.
   *  커밋은 최신 세대의 응답만, 통째로(스펙 §4.1). transient 는 payload 를 안 건드린다(K3). */
  function applyResult_(st, g, res) {
    if (g !== st.gen) return 'stale';
    if (res && res.ok) {
      st.payload = res.data;
      st.committedRange = res.data.range;
      st.serverOk = true;                      // 이 키로 서버가 실제로 응답했다
      if (st.view !== null && !findTeam_(res.data, st.view)) st.view = null;
      return 'committed';
    }
    var code = String((res && res.error && res.error.code) || '');
    if (code === 'AUTH') return 'auth';
    if (code === 'CONFIG') return 'config';
    return 'transient';
  }

  /** 키 지우기/AUTH 공통 — 단일 원자적 초기화(스펙 §4.1, Codex 2차).
   *  gen 증가가 핵심이다: 진행 중 조회의 성공 응답이 늦게 와도 stale 로 버려진다. */
  function resetKey_(st) {
    st.gen += 1;
    st.key = '';
    st.payload = null;
    st.committedRange = null;
    st.view = null;
    st.serverOk = false;
  }

  /** 현재 보기의 블록들. 범위 오류면 null(호출부가 사유를 그린다). */
  function blocksFor_(data, viewName) {
    if (!data || (data.range && data.range.error)) return null;
    if (viewName === null) return data.all.blocks;
    var t = findTeam_(data, viewName);
    return t ? t.blocks : data.all.blocks;
  }

  /** 팀 select 옵션 목록 — value 는 'all' 또는 't<i>'(팀명을 DOM value 로 안 쓴다:
   *  빈 문자열 팀명이 '전체' 와 섞이는 것을 막는다). */
  /** 팀 선택지 — **건수를 붙이지 않는다**(사용자 지시 2026-08-19).
   *  붙였던 수는 그 기간의 '점검 건수'인데, 바로 아래 「미점검 N」과 나란히 놓이면서
   *  같은 종류의 수로 읽혔다. 고를 때 필요한 것은 팀 이름뿐이고, 건수는 표가 이미 말한다. */
  function teamOptions_(data) {
    var out = [{ value: 'all', text: '전체' }];
    data.teams.forEach(function (t, i) {
      out.push({ value: 't' + i, text: t.label });
    });
    return out;
  }

  /* ---------- CSV (스펙 §6) ---------- */

  /** 셀 하나 — 소독(수식 주입) → 인용 순서.
   *  판정은 "시작 문자" 가 아니라 **선행 공백·제어문자를 지난 첫 유효 문자**다:
   *  \t=SUM · \r=SUM · " =SUM" 이 알려진 우회다(Codex 1차 ③). 시트의 s_() 소독은
   *  읽어 올 때 아포스트로피가 벗겨지므로 여기서 다시 한다(스펙 §6).
   *  number 는 수식을 담을 수 없다 — 그대로 내보낸다(음수 -5 를 '-5 로 오염시키지 않는다). */
  function csvField_(v) {
    if (typeof v === 'number') return String(v);
    var s = String(v === null || v === undefined ? '' : v);
    var m = /^[ \t\r\n\u0000-\u001F]*([\s\S])/.exec(s);
    if (m && '=+-@'.indexOf(m[1]) >= 0) s = "'" + s;
    if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  /** 표 블록 → CSV 본문. BOM 은 downloadCsv_ 가 붙인다(생성/인코딩 분리). */
  function buildCsv_(block) {
    var lines = [block.header.map(csvField_).join(',')];
    block.rows.forEach(function (r) { lines.push(r.map(csvField_).join(',')); });
    return lines.join('\r\n');
  }

  /** 파일명 성분 정규화 — 팀명은 시트에서 온 임의 문자열이다(스펙 §6). */
  function fileSafe_(s) {
    var t = String(s || '').replace(/[\/\\:*?"<>|\u0000-\u001F]/g, '_');
    return t.length > 30 ? t.slice(0, 30) : t;
  }

  /** 팀·범위가 파일명에 남아야 나중에 어느 조건의 표인지 안다(스펙 §6). */
  function csvFileName_(kind, teamLabel, rng) {
    return kind + '_' + fileSafe_(teamLabel) + '_' + rng.from + '_' + rng.to + '.csv';
  }

  function downloadCsv_(filename, text) {
    var blob = new Blob(['\uFEFF' + text], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  }

  /** 협력회사별·공사별 블록 머리(제목 오른쪽)에 CSV 버튼. 파일명·데이터 모두 커밋된
   *  상태에서만 나온다 — 진행 중 조회(범위 B)와 섞이지 않도록 **committedRange** 를
   *  쓴다(스펙 §4.1). sec 의 firstChild 는 renderBlock_ 이 만든 .dash-block-head 다. */
  function appendCsvButton_(sec, block, kind) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dash-btn';
    btn.textContent = 'CSV 다운로드';
    btn.addEventListener('click', function () {
      var team = state.view === null ? '전체' : (findTeam_(state.payload, state.view) || { label: '전체' }).label;
      downloadCsv_(csvFileName_(kind, team, state.committedRange), buildCsv_(block));
    });
    sec.firstChild.appendChild(btn);
  }

  /* ---------- 네트워크 — app.js §네트워크의 사본 ----------
     app.js 는 닫힌 IIFE 라 가져올 수 없다. 봉투({ok,...} 로만 resolve)·타임아웃 규약을
     바꾸지 말 것 — wiring 16 계열이 지키는 계약과 같은 형태다. */
  var REQUEST_TIMEOUT_MS = 25000;
  var TIMEOUT_MESSAGE = '서버 응답이 없어 ' + Math.round(REQUEST_TIMEOUT_MS / 1000) + '초 만에 요청을 중단했습니다';
  function requestJson(url, options) {
    var opts = {};
    Object.keys(options || {}).forEach(function (k) { opts[k] = options[k]; });
    var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
    if (ctrl) opts.signal = ctrl.signal;
    return new Promise(function (resolve) {
      var settled = false, timedOut = false;
      var timer = setTimeout(function () {
        timedOut = true;
        if (ctrl) { try { ctrl.abort(); } catch (e) { /* abort 실패해도 아래에서 확정한다 */ } }
        finish({ ok: false, error: { code: 'NETWORK', message: TIMEOUT_MESSAGE } });
      }, REQUEST_TIMEOUT_MS);
      function finish(v) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      }
      fetch(url, opts).then(function (res) {
        return res.json().then(finish, function () {
          finish({ ok: false, error: { code: 'NETWORK', message: '서버 응답을 해석할 수 없습니다(비-JSON)' } });
        });
      }, function (err) {
        finish({ ok: false, error: { code: 'NETWORK', message: timedOut ? TIMEOUT_MESSAGE : ((err && err.message) || '네트워크 오류') } });
      }).catch(function (err) {
        finish({ ok: false, error: { code: 'NETWORK', message: (err && err.message) || '네트워크 오류' } });
      });
    });
  }

  /* ---------- DOM ---------- */

  function el_(id) { return document.getElementById(id); }

  /* 다크 모드 — 킷 tokens.css 의 [data-theme="dark"] 팔레트를 그대로 쓴다(색 발명 0).
   *  라이트 복귀는 속성 제거 — 킷 셀렉터 계약과 일치시킨다. */
  function applyTheme_(mode) {
    if (mode === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    el_('btn-dash-theme').textContent = mode === 'dark' ? '밝게' : '어둡게';
  }

  function showBanner_(text, isError) {
    var b = el_('dash-banner');
    b.textContent = '';
    if (!text) return;
    var div = document.createElement('div');
    div.className = 'dash-banner' + (isError ? ' dash-banner-error' : '');
    div.textContent = text;
    b.appendChild(div);
  }

  /** 키 입력 화면으로 — 데이터 DOM 은 호출 전에 이미 비워져 있어야 한다(§4.1). */
  function showKeyScreen_(msg) {
    el_('dash-key-screen').hidden = false;
    el_('dash-controls').hidden = true;
    el_('btn-dash-refresh').hidden = true;
    el_('btn-dash-monthly').hidden = true;
    el_('btn-dash-clearkey').hidden = true;
    el_('dash-generated').textContent = '';
    showBanner_(msg || '', !!msg);
    el_('dash-key-input').value = '';
    el_('dash-key-input').focus();
  }

  function showMainScreen_() {
    el_('dash-key-screen').hidden = true;
    el_('dash-controls').hidden = false;
    el_('btn-dash-refresh').hidden = false;
    el_('btn-dash-monthly').hidden = false;
    el_('btn-dash-clearkey').hidden = false;
  }

  function wipeData_() {
    el_('dash-blocks').textContent = '';
    el_('dash-generated').textContent = '';
    el_('dash-team').textContent = '';
  }

  /** 키 지우기·AUTH 의 DOM 쪽 절반 — resetKey_(상태) 와 항상 함께 부른다.
   *  모달도 닫는다 — 열린 팝업에 남은 데이터가 곧 열람이다(§4.1 과 같은 이유). */
  function hardReset_(msg) {
    resetKey_(state);
    closeModal_();
    monthly.ym = '';
    monthly.data = null;                       // 메모리에 남은 리포트도 키와 함께 버린다
    try {
      localStorage.removeItem(KEY_STORE);
      localStorage.removeItem(PAYLOAD_STORE);   // 키가 없으면 화면 사본도 남기지 않는다
    } catch (e) { /* 프라이빗 모드 등 — 상태는 이미 비웠다 */ }
    wipeData_();
    showKeyScreen_(msg);
  }

  /* ---------- 드릴다운 모달 — 공사별 점검·부적합 팝업 (2026-08-08 확장) ----------
     상세는 커밋된 조건(committedRange·현재 팀)만으로 서버에 묻는다(§4.1 규칙 그대로).
     modal.gen 은 모달 전용 세대 — 닫히거나 새 요청이 시작되면 늦은 응답을 버린다. */

  var modal = { gen: 0, list: null, listTitle: '', listExpected: undefined, hasHistory: false };

  /** 상세 조회 페이로드(순수 — 조각 테스트 대상). st 의 key·committedRange·view 만 쓴다.
   *  전송은 GET 쿼리가 아니라 **POST 본문**이다 — 데스크톱·폰 공통으로 긴 쿼리 GET fetch 만
   *  Failed to fetch 로 죽는 실사례(주소창·curl 은 정상)가 있어, 제출이 매일 쓰는 검증된
   *  전송로(text/plain simple request)로 맞췄다. */
  function detailPayload_(st, kind, key, extra) {
    var rng = st.committedRange;
    var p = { kind: kind, from: rng.from, to: rng.to };
    if (key !== null) p.key = key;
    if (st.view === null) p.scope = 'all';
    else { p.scope = 'team'; p.team = st.view; }   // '' 팀((팀 없음))도 명시 스코프
    Object.keys(extra || {}).forEach(function (k2) { p[k2] = extra[k2]; });
    return p;
  }

  function openModal_(title) {
    var root = el_('dash-modal');
    if (root.hidden) {
      /* 닫힘→열림 전이에만: ① 히스토리 1칸 — 뒤로가기가 페이지 이탈 대신 팝업을 닫는다
         ② 본문 스크롤 잠금 — 팝업 스크롤이 끝에 닿아도 뒤 화면이 안 움직인다 */
      history.pushState({ dashModal: 1 }, '');
      modal.hasHistory = true;
      document.body.style.overflow = 'hidden';
    }
    el_('dash-modal-title').textContent = title;
    el_('dash-modal-body').textContent = '';
    el_('btn-dash-modal-back').hidden = true;
    root.hidden = false;
  }

  function closeModal_() {
    modal.gen += 1;                            // 진행 중 상세 응답 무효화
    modal.list = null;
    modal.listTitle = '';
    modal.listExpected = undefined;
    el_('dash-modal').hidden = true;
    /* 본문을 **비운다.** hidden 은 눈에서만 가릴 뿐 DOM 에는 조회 데이터가 그대로 남는다 —
       키를 지운 기기에 남은 그것이 곧 열람이다(hardReset_ 이 모달을 닫는 이유 그 자체인데,
       닫기만 해서는 절반만 지켜졌다. 2026-08-19 디버깅 실측).
       여는 쪽(openModal_)도 비우지만, 그때는 이미 남아 있던 시간이 지난 뒤다. */
    el_('dash-modal-body').textContent = '';
    el_('dash-modal-title').textContent = '';
    document.body.style.overflow = '';
    if (modal.hasHistory) {                    // 우리가 쌓은 히스토리 1칸을 소비(뒤로가기와 이중 처리 방지)
      modal.hasHistory = false;
      history.back();
    }
  }

  function metaP_(text) {
    var p = document.createElement('p');
    p.className = 'dash-modal-meta';
    p.textContent = text;
    return p;
  }

  function modalMsg_(text, isError) {
    var body = el_('dash-modal-body');
    body.textContent = '';
    var p = document.createElement('p');
    p.className = isError ? 'dash-banner dash-banner-error' : 'dash-modal-meta';
    p.textContent = text;
    body.appendChild(p);
  }

  /** 모달 안 조회의 **공통 규약** — 세대 검사·AUTH 하드리셋·팝업 안 재시도. action 과
   *  payload 만 다르다. 드릴다운(dashboard_detail)과 월간 리포트(dashboard_monthly)가
   *  이걸 함께 쓴다 — 따로 쓰면 언젠가 한쪽만 세대 검사를 잃는다(늦은 응답이 화면을 덮는다).
   *
   *  본문을 **통째로 함수로** 받는다(action 만 받지 않는다). 두 가지를 동시에 얻는다:
   *  ① 재시도할 때 **그때의 상태**로 다시 만든다 ② action 문자열이 호출부에 리터럴로 남아
   *  앱-서버 action 대조(wiring 25a)가 계속 눈으로 볼 수 있다 — 변수로 넘기면 그 검증이
   *  조용히 장님이 되고, 오타는 현장에서 '알 수 없는 action'(영구 오류)으로만 발각된다. */
  function fetchModal_(bodyOf, render) {
    var g = ++modal.gen;
    modalMsg_('불러오는 중', false);
    requestJson(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(bodyOf()),
      redirect: 'follow'
    }).then(function (res) {
      if (g !== modal.gen) return;             // 닫혔거나 새 요청이 이겼다 — 화면을 건드리지 않는다
      if (res && res.ok) { render(res.data); return; }
      var code = String((res && res.error && res.error.code) || '');
      if (code === 'AUTH') { hardReset_('키가 맞지 않습니다 — 다시 입력하세요'); return; }
      /* 일시 오류(네트워크 히컵 등)는 팝업 안에서 바로 재시도(K3) — 닫았다 다시 열게 하지 않는다 */
      modalMsg_('불러오지 못했습니다 — ' + ((res && res.error && res.error.message) || ''), true);
      var retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'dash-btn';
      retry.textContent = '다시 시도';
      retry.addEventListener('click', function () { fetchModal_(bodyOf, render); });
      el_('dash-modal-body').appendChild(retry);
    });
  }

  function fetchDetail_(kind, key, extra, render) {
    fetchModal_(function () {
      return { action: 'dashboard_detail', k: state.key,
               payload: detailPayload_(state, kind, key, extra) };
    }, render);
  }

  /** 모달용 표 — 본문 표와 같은 스타일 계열(.dash-block table)을 재사용한다. */
  function modalTable_(header, rows, trOf) {
    var block = document.createElement('div');
    block.className = 'dash-block dash-modal-tables';
    var wrap = document.createElement('div');
    wrap.className = 'dash-tablewrap';
    var table = document.createElement('table');
    var thead = document.createElement('thead');
    var hr = document.createElement('tr');
    header.forEach(function (t) {
      var th = document.createElement('th');
      th.textContent = t;
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);
    var tbody = document.createElement('tbody');
    rows.forEach(function (row, ri) { tbody.appendChild(trOf(row, ri)); });
    table.appendChild(tbody);
    wrap.appendChild(table);
    block.appendChild(wrap);
    return block;
  }

  /** 표의 숫자와 상세 건수가 다르면 — 표 조회 이후 원장이 바뀐 것이다. 숨기지 않고
   *  신선한 데이터를 보여 주되 차이를 명시한다(K4 — 조용한 불일치 금지, 적대 리뷰 #2). */
  function staleNotice_(body, expected, actual) {
    if (typeof expected !== 'number' || expected === actual) return;
    var p = document.createElement('p');
    p.className = 'dash-banner dash-banner-error';
    p.textContent = '표를 조회한 뒤 기록이 바뀌었습니다(표 ' + expected + '건 → 현재 ' + actual +
      '건) — 새로고침을 누르면 표도 갱신됩니다';
    body.appendChild(p);
  }

  /** 부적합 내용 목록 — 긴 항목 문구가 많아 표 대신 카드로(가독성, 사용자 지시 2026-08-08).
   *  카드: 메타(점검일·점검자·분류) / 항목 전문(줄바꿈) / 내용은 강조 박스. */
  function renderFinds_(data, expected) {
    var body = el_('dash-modal-body');
    el_('btn-dash-modal-back').hidden = true;
    body.textContent = '';
    staleNotice_(body, expected, data.rows.length);
    if (!data.rows.length) { body.appendChild(metaP_('이 조건의 부적합이 없습니다')); return; }
    data.rows.forEach(function (r) {
      var card = document.createElement('div');
      card.className = 'dash-findcard';
      var meta = document.createElement('p');
      meta.className = 'meta';
      meta.textContent = r.date + ' · ' + r.inspector + (r.category ? ' · ' + r.category : '');
      card.appendChild(meta);
      var item = document.createElement('p');
      item.className = 'item';
      item.textContent = String(r.item == null ? '' : r.item);
      card.appendChild(item);
      if (String(r.note || '')) {
        var note = document.createElement('p');
        note.className = 'note';
        note.textContent = String(r.note);
        card.appendChild(note);
      }
      body.appendChild(card);
    });
  }

  /** 점검 목록 — 행을 누르면 그 점검의 전체 점검표로. */
  function renderSubs_(data, expected) {
    var body = el_('dash-modal-body');
    el_('btn-dash-modal-back').hidden = true;
    modal.list = data;                          // 「목록으로」 캐시(재조회 없음)
    modal.listExpected = expected;
    body.textContent = '';
    staleNotice_(body, expected, data.rows.length);
    if (!data.rows.length) { body.appendChild(metaP_('이 조건의 점검이 없습니다')); return; }
    body.appendChild(metaP_('행을 누르면 그 점검의 전체 점검표가 열립니다'));
    body.appendChild(modalTable_(['점검일', '제출시각', '점검자', '팀', '부적합'], data.rows, function (r) {
      var tr = document.createElement('tr');
      tr.className = 'dash-rowlink';
      tr.setAttribute('tabindex', '0');
      tr.setAttribute('role', 'button');
      [r.date, r.time, r.inspector, r.team, r.finds].forEach(function (v, i) {
        var td = document.createElement('td');
        td.textContent = String(v == null ? '' : v);
        if (i === 4) td.className = 'dash-num' + (Number(v) > 0 ? ' dash-danger' : '');
        tr.appendChild(td);
      });
      function openIt() { fetchDetail_('sheet', null, { sid: r.sid }, renderSheet_); }
      tr.addEventListener('click', openIt);
      tr.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openIt(); }
      });
      return tr;
    }));
  }

  /** 점검 1건의 전체 점검표 — 그 버전의 항목 문구 그대로(서버 kind=sheet). */
  function renderSheet_(data) {
    var body = el_('dash-modal-body');
    el_('btn-dash-modal-back').hidden = !modal.list;   // 목록 경유일 때만 「목록으로」
    body.textContent = '';
    var meta = data.meta;
    el_('dash-modal-title').textContent = '점검표 — ' + meta.company_name + ' · ' + meta.project_name;
    var info = document.createElement('p');
    info.className = 'dash-modal-meta';
    info.textContent = meta.company_name + ' · ' + meta.project_name +
      ' · 점검일 ' + meta.inspect_date +
      ' · 점검자 ' + meta.inspector_name + (meta.inspector_team ? '(' + meta.inspector_team + ')' : '') +
      ' · 수검자 ' + (meta.auditee || '-') + (meta.auditee_ack ? ' (확인함)' : '') +
      (meta.status === 'voided' ? ' · 취소된 점검' : '');
    body.appendChild(info);
    var sheetTbl = modalTable_(['항목', '판정'], data.rows, function (r) {
      var tr = document.createElement('tr');
      if (r.head) {                             // 체크 불가 행(주의문 등) — 구획 줄
        var td = document.createElement('td');
        td.colSpan = 2;
        td.className = 'dash-sheet-section';
        td.textContent = r.text;
        tr.appendChild(td);
        return tr;
      }
      /* 사유는 별도 열이 아니라 항목 아래 강조 박스 — 사유 있는 행이 소수라 열을 상시
         차지하면 폰에서 항목이 너무 잘게 접힌다(부적합 카드 note 와 같은 문법). */
      var t1 = document.createElement('td');
      t1.className = 'dash-wraptext';
      var txt = document.createElement('div');
      txt.textContent = r.text;
      t1.appendChild(txt);
      if (String(r.n || '')) {
        var note = document.createElement('div');
        note.className = 'dash-sheet-note';
        note.textContent = r.n;
        t1.appendChild(note);
      }
      var t2 = document.createElement('td');
      t2.textContent = r.r || '-';
      if (r.r === 'N') t2.className = 'dash-danger';
      tr.appendChild(t1);
      tr.appendChild(t2);
      return tr;
    });
    sheetTbl.className += ' dash-sheet';        // 고정 레이아웃 — 항목이 폭 안에서 줄바꿈(가로 스크롤 제거)
    body.appendChild(sheetTbl);
  }

  /** 공사별 숫자 클릭 진입점. kind: 'subs'(점검) | 'finds'(부적합).
   *  expected = 클릭한 숫자 — 상세 건수와 다르면 표 이후 원장이 바뀐 것(안내 표시). */
  function openDetail_(kind, key, rowLabel, expected) {
    if (!state.committedRange || state.committedRange.error) return;   // 커밋 전·범위오류엔 표가 없다
    var title = (kind === 'subs' ? '점검 목록 — ' : '부적합 내용 — ') + rowLabel;
    if (kind === 'subs') modal.listTitle = title;
    openModal_(title);
    if (kind === 'subs') fetchDetail_('subs', key, null, function (d) { renderSubs_(d, expected); });
    else fetchDetail_('finds', key, null, function (d) { renderFinds_(d, expected); });
  }

  /** '제목 (YYYY-MM-DD ~ YYYY-MM-DD)' 에서 주간 스트립 모델을 만든다 — 순수 계산.
   *  ISO 문자열을 Date 에 직접 주면 UTC 자정이 되어 시간대에 따라 하루가 밀린다 —
   *  로컬 부품(연·월·일 정수)으로만 조립한다. 형식이 다르면 null(스트립 없이 원제목 유지). */
  function weekStripModel_(title, today) {
    var m = /^(.*?)\s*\((\d{4})-(\d{2})-(\d{2})\s*~\s*(\d{4})-(\d{2})-(\d{2})\)\s*$/.exec(String(title));
    if (!m) return null;
    var DOW = ['일', '월', '화', '수', '목', '금', '토'];
    var t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    var days = [];
    for (var i = 0; i < 7; i++) {
      var d = new Date(Number(m[2]), Number(m[3]) - 1, Number(m[4]) + i);
      var state = d.getTime() === t0 ? 'today' : (d.getTime() < t0 ? 'past' : 'future');
      days.push({ dow: DOW[d.getDay()], day: d.getDate(), state: state });
    }
    return { label: m[1], days: days };
  }

  /** 주간 스트립 렌더(사용자 선택 2026-08-10). role="img" — 칸들은 하나의 그림이다. */
  function renderWeekStrip_(model, fullTitle) {
    var strip = document.createElement('div');
    strip.className = 'dash-weekstrip';
    strip.setAttribute('role', 'img');
    strip.setAttribute('aria-label', String(fullTitle));
    model.days.forEach(function (dy) {
      var cell = document.createElement('div');
      cell.className = 'dash-wday' + (dy.state === 'today' ? ' today' : dy.state === 'past' ? ' past' : '');
      if (dy.state === 'today') cell.setAttribute('aria-current', 'date');
      var w = document.createElement('span');
      w.className = 'dow';
      w.textContent = dy.dow;
      var n = document.createElement('span');
      n.className = 'num';
      n.textContent = String(dy.day);
      cell.appendChild(w);
      cell.appendChild(n);
      strip.appendChild(cell);
    });
    return strip;
  }

  /** 헤더 없는 요약 블록(이번 주)의 라벨·값 쌍을 스탯 타일로 그린다 —
   *  표 한 줄보다 위계가 서고 모바일(2×2)에서도 읽힌다. 부적합>0 만 상태색. */
  function renderStatTiles_(block) {
    var grid = document.createElement('div');
    grid.className = 'dash-tiles';
    var row = block.rows[0] || [];
    for (var i = 0; i + 1 < row.length; i += 2) {
      var tile = document.createElement('div');
      tile.className = 'dash-tile';
      var k = document.createElement('span');
      k.className = 'k';
      k.textContent = String(row[i]);
      var v = document.createElement('span');
      v.className = 'v' + (row[i] === '부적합' && Number(row[i + 1]) > 0 ? ' dash-danger' : '');
      v.textContent = String(row[i + 1]);
      tile.appendChild(k);
      tile.appendChild(v);
      grid.appendChild(tile);
    }
    return grid;
  }

  /** 공사별 카드 목록(모바일) — 5열 표가 좁은 화면에서 가로 스크롤로 밀리는 문제.
   *  표와 같은 데이터·같은 드릴다운 버튼(점검·부적합)을 카드로도 만든다. textContent 전용. */
  function renderProjCards_(block) {
    var wrap = document.createElement('div');
    wrap.className = 'dash-proj-cards';
    function lbl(t) {
      var s = document.createElement('span');
      s.className = 'lbl';
      s.textContent = t;
      return s;
    }
    block.rows.forEach(function (row, ri) {
      var card = document.createElement('div');
      card.className = 'dash-projcard';
      var comp = document.createElement('p');
      comp.className = 'comp';
      comp.textContent = String(row[0]);
      var proj = document.createElement('p');
      proj.className = 'proj';
      proj.textContent = String(row[1]);
      var nums = document.createElement('p');
      nums.className = 'nums';
      var label = String(row[0]) + ' · ' + String(row[1]);
      nums.appendChild(lbl('점검 '));
      var insp = document.createElement('button');
      insp.type = 'button';
      insp.className = 'dash-linknum';
      insp.textContent = String(row[2]);
      insp.addEventListener('click', function () { openDetail_('subs', block.keys[ri], label, Number(row[2])); });
      nums.appendChild(insp);
      nums.appendChild(lbl(' · 부적합 '));
      if (Number(row[3]) > 0) {
        var fb = document.createElement('button');
        fb.type = 'button';
        fb.className = 'dash-linknum dash-danger';
        fb.textContent = String(row[3]);
        fb.addEventListener('click', function () { openDetail_('finds', block.keys[ri], label, Number(row[3])); });
        nums.appendChild(fb);
      } else {
        nums.appendChild(lbl('0'));
      }
      nums.appendChild(lbl(' · 마지막 ' + String(row[4] || '-')));
      card.appendChild(comp);
      card.appendChild(proj);
      card.appendChild(nums);
      wrap.appendChild(card);
    });
    return wrap;
  }

  /** 블록 하나 렌더. textContent 만 쓴다(시트 유래 문자열의 HTML 해석 원천 차단).
   *  부적합 값은 header 의 '부적합' 열, 헤더 없는 블록(이번 주)은 타일로. */
  function renderBlock_(block) {
    var sec = document.createElement('section');
    sec.className = 'dash-block';
    var head = document.createElement('div');   // 제목 + CSV 버튼 자리(appendCsvButton_ 이 붙인다)
    head.className = 'dash-block-head';
    var h = document.createElement('h2');
    h.textContent = block.title;
    head.appendChild(h);
    sec.appendChild(head);

    if (!block.header || !block.header.length) {
      var wk = weekStripModel_(block.title, new Date());
      if (wk) {
        h.textContent = wk.label;   // 괄호 날짜 범위는 스트립이 대신한다(aria 에는 전체 제목)
        sec.appendChild(renderWeekStrip_(wk, block.title));
      }
      sec.appendChild(renderStatTiles_(block));
    } else {
      var dangerCol = block.header.indexOf('부적합');
      /* 숫자 열은 우측 정렬 — 첫 데이터 행의 타입으로 판정(서버가 집계 수를 number 로 보낸다) */
      var numCols = {};
      if (block.rows.length) {
        block.rows[0].forEach(function (c, i) { if (typeof c === 'number') numCols[i] = true; });
      }
      var wrap = document.createElement('div');
      wrap.className = 'dash-tablewrap';
      var table = document.createElement('table');
      var thead = document.createElement('thead');
      var hr = document.createElement('tr');
      block.header.forEach(function (t, i) {
        var th = document.createElement('th');
        th.textContent = t;
        if (numCols[i]) th.className = 'dash-num';
        hr.appendChild(th);
      });
      thead.appendChild(hr);
      table.appendChild(thead);
      var tbody = document.createElement('tbody');
      block.rows.forEach(function (row, ri) {
        var tr = document.createElement('tr');
        row.forEach(function (cell, i) {
          var td = document.createElement('td');
          var cls = numCols[i] ? 'dash-num' : '';
          if (i === dangerCol && Number(cell) > 0) cls += (cls ? ' ' : '') + 'dash-danger';
          if (cls) td.className = cls;
          /* keys 가 있는 블록(공사별)의 점검·부적합 숫자는 드릴다운 버튼 —
             부적합 0 은 열어 볼 내용이 없으니 일반 텍스트로 둔다. */
          var clickable = block.keys &&
            (block.header[i] === '점검' || (block.header[i] === '부적합' && Number(cell) > 0));
          if (clickable) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'dash-linknum' + (block.header[i] === '부적합' ? ' dash-danger' : '');
            btn.textContent = String(cell);
            (function (kind, key, label, expected) {
              btn.addEventListener('click', function () { openDetail_(kind, key, label, expected); });
            })(block.header[i] === '점검' ? 'subs' : 'finds', block.keys[ri],
               String(row[0]) + ' · ' + String(row[1]), Number(cell));
            td.appendChild(btn);
          } else {
            td.textContent = String(cell);
          }
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      wrap.appendChild(table);
      sec.appendChild(wrap);
      if (block.keys) {                        // 공사별 — 좁은 화면용 카드도 함께(CSS 가 폭에 따라 하나만 보인다)
        sec.className += ' dash-block-has-cards';
        sec.appendChild(renderProjCards_(block));
      }
    }
    if (block.note) {
      var note = document.createElement('p');
      note.className = 'note';
      note.textContent = block.note;
      sec.appendChild(note);
    }
    return sec;
  }

  /* ---------- 월간 리포트 (사용자 지시 2026-08-19) ----------------------
     "한달간 수행한 공사와 공사 중 미점검 확정 항목은 별도로 구분되어야 해.
      하나의 공사에 여러 건의 점검이 있을 경우 하나의 미점검 확정이 기존 기록을 건드리면 안돼."

     화면도 그 구분을 그대로 따른다 — **표 두 개**다. 하나로 합쳐 '상태' 열을 두는 안은
     버렸다: 한 공사에 점검 2건 + 확정 1건이면 그 공사의 '상태'를 한 값으로 못 적는다.
     겹치는 공사는 양쪽에 나오되 그것이 정상임을 요약줄이 말한다.

     **전체 기준이다** — 팀 전환과 무관하다. 한 공사를 두 팀이 점검하면 공사 단위 행의 팀을
     하나로 정할 수 없어 팀 필터가 숫자를 조용히 틀어 놓는다. 화면에 그렇게 적는다. */

  var monthly = { ym: '', data: null };

  /** 오늘이 속한 연월(YYYY-MM). 시간대 함정을 피해 로컬 값 그대로 만든다(todayStr_ 와 같은 결). */
  function thisMonth_() { return todayStr_().slice(0, 7); }

  function mrErrorText_(code, message) {
    var key = String(message || '').split(',')[0].trim();
    if (key === 'YM_INVALID' || code === 'YM_INVALID') return '연월을 2026-08 형식으로 고르세요';
    return String(message || '월간 리포트를 불러오지 못했습니다');
  }

  /** 연월 고르는 줄 — 조회 뒤에도 남는다(다른 달로 바로 넘어가려고). */
  function monthlyPicker_(onGo) {
    var bar = document.createElement('div');
    bar.className = 'dash-mr-bar';

    var lab = document.createElement('label');
    lab.textContent = '연월';
    lab.htmlFor = 'dash-mr-ym';
    bar.appendChild(lab);

    var input = document.createElement('input');
    input.type = 'month';
    input.id = 'dash-mr-ym';
    input.max = thisMonth_();                  // 오지 않은 달의 '실적' 은 없다
    input.value = monthly.ym || thisMonth_();
    bar.appendChild(input);

    var go = document.createElement('button');
    go.type = 'button';
    go.className = 'dash-btn dash-btn-primary';
    go.textContent = '조회';
    go.addEventListener('click', function () { onGo(String(input.value || '')); });
    bar.appendChild(go);
    return bar;
  }

  /** 요약 — 두 절의 숫자를 **따로** 읽게 한다. 합계 한 줄로 뭉치면 확정이 실적을 깎은 것처럼
   *  읽힌다(사용자가 못 박은 계약과 정반대의 인상). 겹치는 공사 수를 명시하는 이유도 같다. */
  function monthlySummary_(d) {
    var wrap = document.createElement('div');
    wrap.className = 'dash-mr-sum';
    [['수행', '점검 ' + d.done.subs + '건 · 공사 ' + d.done.projects + '건 · 부적합 ' + d.done.findings + '건', ''],
     ['미점검확정', '확정 ' + d.unchecked.plans + '건 · 공사 ' + d.unchecked.projects + '건', 'dash-mr-tile-un']
    ].forEach(function (t) {
      var tile = document.createElement('div');
      tile.className = 'dash-mr-tile' + (t[2] ? ' ' + t[2] : '');
      var k = document.createElement('span');
      k.className = 'k';
      k.textContent = t[0];
      var v = document.createElement('span');
      v.className = 'v';
      v.textContent = t[1];
      tile.appendChild(k);
      tile.appendChild(v);
      wrap.appendChild(tile);
    });
    return wrap;
  }

  /** 「확인이 필요한 것」 — 숫자를 흔드는 조건을 리포트 **안에** 적는다.
   *  없으면 절 자체를 만들지 않는다(빈 절은 "확인할 게 있나?" 하고 매번 읽게 만든다). */
  function monthlyIssues_(d) {
    var list = (d && d.notes) || [];
    if (!list.length) return null;
    var sec = document.createElement('section');
    sec.className = 'dash-mr-sec';
    var h = document.createElement('h3');
    h.textContent = '■ 확인이 필요한 것';
    sec.appendChild(h);
    list.forEach(function (n) {
      var p = document.createElement('p');
      p.className = 'dash-od-warn';
      p.textContent = n.label + ' ' + n.count + '건 — ' + n.hint;
      sec.appendChild(p);
    });
    return sec;
  }

  function monthlyNote_(d) {
    var p = document.createElement('p');
    p.className = 'dash-modal-meta';
    p.textContent = d.overlapProjects
      ? '두 표에 함께 나오는 공사 ' + d.overlapProjects + '건 — 같은 공사의 다른 점검 건입니다. ' +
        '미점검확정은 그 공사의 수행 기록을 건드리지 않습니다.'
      : '수행과 미점검확정에 겹치는 공사가 없습니다.';
    return p;
  }

  /** 절 하나 = 제목 + CSV 버튼 + 표. CSV 는 화면에 보이는 그 표 그대로다. */
  function monthlySection_(title, kind, header, rows, cellsOf) {
    var sec = document.createElement('section');
    sec.className = 'dash-mr-sec';
    var head = document.createElement('div');
    head.className = 'dash-block-head';
    var h = document.createElement('h3');
    h.textContent = title;
    head.appendChild(h);
    var sp = document.createElement('span');
    sp.className = 'spacer';
    head.appendChild(sp);
    var cells = rows.map(cellsOf);
    if (cells.length) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dash-btn';
      btn.textContent = 'CSV 다운로드';
      btn.addEventListener('click', function () {
        downloadCsv_('월간_' + kind + '_' + monthly.ym + '.csv',
                     buildCsv_({ header: header, rows: cells }));
      });
      head.appendChild(btn);
    }
    sec.appendChild(head);
    if (!cells.length) {
      sec.appendChild(metaP_('이 달에 해당 항목이 없습니다'));
      return sec;
    }
    sec.appendChild(modalTable_(header, cells, function (row) {
      var tr = document.createElement('tr');
      row.forEach(function (c) {
        var td = document.createElement('td');
        td.textContent = String(c === null || c === undefined ? '' : c);
        tr.appendChild(td);
      });
      return tr;
    }));
    return sec;
  }

  function renderMonthly_(d) {
    monthly.data = d;
    monthly.ym = d.ym;
    openModal_('월간 리포트 — ' + d.ym.replace('-', '년 ') + '월');
    var body = el_('dash-modal-body');
    body.textContent = '';
    body.appendChild(monthlyPicker_(fetchMonthly_));
    body.appendChild(metaP_('기준 ' + d.generatedAt + ' · 전체 기준입니다(팀 전환과 무관).'));
    body.appendChild(monthlySummary_(d));
    body.appendChild(monthlyNote_(d));

    body.appendChild(monthlySection_('■ 수행 — 공사별', '수행',
      ['협력회사', '공사', '점검 건수', '부적합 건수', '첫 점검일', '마지막 점검일'],
      d.done.rows, function (r) {
        return [r.company_name, r.project_name, r.count, r.findings, r.first, r.last];
      }));

    /* 미점검확정은 **공사별로 접지 않는다** — 확정 1건 = 1행이다. 접으면 같은 공사의 확정
       두 건이 한 줄이 되어 언제 예정이던 건인지·누가 확정했는지가 사라진다. */
    /* 제목에 '확정 1건 = 1행' 을 적었더니 행이 여럿인 표 위에서 **건수로 읽혔다**
       (2026-08-19 캡처에서 발견). 행 단위 의미는 코드 주석과 문서에 남기고 제목은 이름만. */
    body.appendChild(monthlySection_('■ 미점검확정 (확정 건별)', '미점검확정',
      ['협력회사', '공사', '원래 예정일', '확정일시', '확정자', '등록자', '점검팀'],
      d.unchecked.rows, function (r) {
        return [r.company_name, r.project_name, r.planned_date, r.confirmed_at,
                r.confirmed_by, r.owner, r.team];
      }));

    var issues = monthlyIssues_(d);
    if (issues) body.appendChild(issues);
  }

  function fetchMonthly_(ym) {
    var v = String(ym || '');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(v)) {
      /* type=month 를 모르는 브라우저는 이 칸이 그냥 text 다 — 서버까지 보내지 않고 여기서 막는다. */
      modalMsg_(mrErrorText_('YM_INVALID', 'YM_INVALID'), true);
      el_('dash-modal-body').appendChild(monthlyPicker_(fetchMonthly_));
      return;
    }
    monthly.ym = v;
    openModal_('월간 리포트 — ' + v.replace('-', '년 ') + '월');
    fetchModal_(function () {
      return { action: 'dashboard_monthly', k: state.key, payload: { ym: monthly.ym } };
    }, renderMonthly_);
  }

  function openMonthly_() {
    /* 마지막으로 본 달을 기억한다 — 매번 이번 달로 되돌아가면 지난달을 훑는 동안 계속 고쳐야 한다. */
    fetchMonthly_(monthly.ym || thisMonth_());
  }

  /* ── 미점검 (사전등록됐지만 점검하지 않음) ─────────────────────────────
     서버가 `planned + 예정일 지남` 으로 **파생**해 준다(상태를 새로 만들지 않는다).
     조회 기간과 무관하다 — 미점검은 그 기간의 실적이 아니라 **지금 남아 있는 빚**이라
     기간 밖으로 밀려 안 보이면 영영 안 보인다. 그래서 본문 **맨 위**에 둔다. */
  var OD_STALE_DAYS = 7;
  /* 버튼·모달 제목·전송 중 되돌림 문구가 같은 말이어야 한다 — 세 군데에 따로 적으면
     문구를 고칠 때 한 곳이 남는다(전송 실패 뒤 버튼이 다른 이름으로 돌아오는 식). */
  var UNCHECK_LABEL = '미점검확정';
  var WORKCANCEL_LABEL = '공사취소';

  function overdueFor_(data, viewName) {
    var list = (data && data.overdue) || [];
    if (viewName === null) return list;
    return list.filter(function (o) { return String(o.team || '') === viewName; });
  }

  /** 서버 오류 코드를 사람 말로. 영문 토큰을 그대로 띄우면 현장이 무엇을 할지 모른다
   *  (같은 이유로 APP_OUTDATED 를 고친 적이 있다). 모르는 코드는 원문을 보인다.
   *  fallback 은 흐름마다 다르다 — 재등록과 미점검확정이 같은 문구로 실패하면 어느 것이
   *  안 됐는지 알 수 없다. */
  function odErrorText_(code, message, fallback) {
    var m = {
      PIN_MISMATCH: 'PIN 이 맞지 않습니다',
      PIN_LOCKED: 'PIN 을 여러 번 틀려 잠겼습니다 — 10분 뒤에 다시 시도하세요',
      PLAN_DATE_PAST: '지난 날짜로는 재등록할 수 없습니다',
      INSPECTOR_UNKNOWN: '점검자를 찾을 수 없습니다',
      PLAN_NOT_FOUND: '계획을 찾을 수 없습니다 — 새로고침 후 다시 시도하세요',
      PLAN_ID_INVALID: '계획 번호가 올바르지 않습니다 — 새로고침 후 다시 시도하세요',
      PLAN_ALREADY_DONE: '이미 점검이 끝난 계획입니다',
      PLAN_ALREADY_CANCELED: '취소된 계획입니다',
      PLAN_ALREADY_UNCHECKED: '이미 미점검으로 확정한 계획입니다 — 새로고침 후 확인하세요',
      PLAN_NOT_OVERDUE: '예정일이 아직 지나지 않아 미점검으로 확정할 수 없습니다',
      PLAN_DATE_INVALID: '날짜를 다시 확인하세요'
    };
    var key = String(message || '').split(',')[0].trim();
    return m[key] || m[String(code || '')] ||
           String(message || fallback || '처리하지 못했습니다');
  }

  /** 쓰기가 AUTH 로 거절됐을 때 — **키를 지우기 전에 한 번 의심한다.**
   *  조회는 방금 그 키로 됐는데(serverOk) 쓰기만 AUTH 라면, 키가 틀린 게 아니라 **서버가 그
   *  action 을 아직 모르는** 것이다: 배포 안 된 새 action 은 대시보드 게이트에 안 걸려
   *  공유키 게이트로 떨어지고, 거기서 '키 불일치'(AUTH)가 된다.
   *  실측(2026-08-19): 공사취소를 눌렀더니 키가 지워지고 키 입력창이 떠서, 사용자가 PIN 을
   *  키 칸에 넣었다. 원인은 Apps Script 새 버전 배포가 안 된 것이었다. 키를 지워 버리면
   *  사용자는 원인을 모른 채 키부터 다시 찾아야 한다 — 조회는 멀쩡히 되는데도. */
  function odAuthFail_(errBox) {
    if (state.serverOk) {
      errBox.textContent = '서버가 이 기능을 아직 모릅니다 — Apps Script 새 버전 배포가 ' +
        '필요합니다(키 문제가 아닙니다). 조회는 그대로 됩니다.';
      return;
    }
    hardReset_('키가 맞지 않습니다 — 다시 입력하세요');
  }

  function odField_(label, value) {
    var d = document.createElement('div');
    d.className = 'dash-od-field';
    var l = document.createElement('label');
    l.textContent = label;
    if (value.id) l.htmlFor = value.id;          // 라벨을 눌러도 칸이 잡힌다(터치 타깃 확대)
    d.appendChild(l);
    d.appendChild(value);
    return d;
  }

  /** 계획 한 줄 요약 — 두 모달이 같은 문장을 쓴다(무엇을 손대는지가 제목만으로는 부족하다). */
  function odMeta_(o) {
    var meta = document.createElement('p');
    meta.className = 'dash-modal-meta';
    meta.textContent = o.company_name + ' · 원래 예정일 ' + o.planned_date +
                       ' (' + o.days + '일 경과)';
    return meta;
  }

  /** 사람 고르기 — 재등록과 미점검확정이 똑같이 요구한다(키는 문턱, PIN 이 신원).
   *  · **팀으로 묶는다**(optgroup): 명단이 평평하면 자기 팀을 찾느라 전부 훑어야 한다.
   *  · **그 계획의 담당자를 미리 골라 둔다**: 되살리거나 확정하는 사람은 거의 언제나 등록한
   *    사람이다. 담당자가 명단에 없으면(비활성·PIN 없음·토큰 없음) 비워 둔다 — 없는 사람을
   *    고른 척하지 않는다.
   *  팀 이름은 시트에서 온 임의 문자열이라 사전은 null-프로토로 만든다(서버 addTeam 과 같은 이유). */
  function odActorSelect_(data, ownerId) {
    var sel = document.createElement('select');
    sel.id = 'dash-od-insp';
    var ph = document.createElement('option');
    ph.value = ''; ph.textContent = '선택하세요';
    sel.appendChild(ph);
    var groups = Object.create(null), order = [];
    (data.inspectors || []).forEach(function (i) {
      var t = String(i.team || '') || '(팀 없음)';
      if (!groups[t]) {
        groups[t] = document.createElement('optgroup');
        groups[t].label = t;
        order.push(t);
      }
      var op = document.createElement('option');
      op.value = i.id;
      op.textContent = i.display;
      groups[t].appendChild(op);
    });
    order.forEach(function (t) { sel.appendChild(groups[t]); });
    var want = String(ownerId || '');
    if (want) {
      for (var k = 0; k < sel.options.length; k++) {
        if (sel.options[k].value === want) { sel.selectedIndex = k; break; }
      }
    }
    return sel;
  }

  function odPinInput_() {
    var pin = document.createElement('input');
    pin.type = 'password';
    pin.id = 'dash-od-pin';
    pin.inputMode = 'numeric';
    pin.autocomplete = 'off';
    pin.maxLength = 8;
    return pin;
  }

  function odErrBox_() {
    var err = document.createElement('p');
    err.className = 'dash-banner dash-banner-error dash-od-err';
    err.setAttribute('aria-live', 'polite');
    return err;
  }

  function submitReschedule_(o, real, date, pin, btn, errBox) {
    errBox.textContent = '';
    if (!real) { errBox.textContent = '점검자를 고르세요'; return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) { errBox.textContent = '날짜를 고르세요'; return; }
    if (!String(pin || '').length) { errBox.textContent = 'PIN 을 입력하세요'; return; }
    btn.disabled = true;
    btn.textContent = '재등록 중...';
    requestJson(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'dash_plan_reschedule', k: state.key,
        payload: { plan_id: o.plan_id, inspector_real_id: real, pin: pin, planned_date: date } }),
      redirect: 'follow'
    }).then(function (res) {
      btn.disabled = false;
      btn.textContent = '재등록';
      if (res && res.ok) {
        closeModal_();
        // 안내는 fetchDashboard 가 **커밋 뒤에** 띄운다 — 여기서 띄우면 같은 틱에 지워진다
        fetchDashboard('재등록했습니다 — ' + date + ' 예정으로 올렸습니다');
        return;
      }
      var code = String((res && res.error && res.error.code) || '');
      if (code === 'AUTH') { odAuthFail_(errBox); return; }
      /* PIN 오류는 **모달 안에서** 알린다 — 닫아 버리면 다시 열어 처음부터 해야 한다. */
      errBox.textContent = odErrorText_(code, res && res.error && res.error.message,
                                        '재등록하지 못했습니다');
    });
  }

  /** 미점검확정 제출 — 예정일을 **보내지 않는다**. 이 버튼은 날짜를 손대는 기능이 아니라
   *  "안 했다" 를 못 박는 기능이다(사용자 지시 2026-08-19). 서버도 예정일을 안 바꾼다. */
  function submitUnchecked_(o, real, pin, btn, errBox) {
    errBox.textContent = '';
    if (!real) { errBox.textContent = '확정하는 사람을 고르세요'; return; }
    if (!String(pin || '').length) { errBox.textContent = 'PIN 을 입력하세요'; return; }
    btn.disabled = true;
    btn.textContent = '확정 중...';
    requestJson(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'dash_plan_unchecked', k: state.key,
        payload: { plan_id: o.plan_id, inspector_real_id: real, pin: pin } }),
      redirect: 'follow'
    }).then(function (res) {
      btn.disabled = false;
      btn.textContent = UNCHECK_LABEL;
      if (res && res.ok) {
        closeModal_();
        // 안내는 fetchDashboard 가 **커밋 뒤에** 띄운다 — 여기서 띄우면 같은 틱에 지워진다
        fetchDashboard('미점검으로 확정했습니다 — 목록에서 내렸습니다(점검 기록은 만들지 않았습니다)');
        return;
      }
      var code = String((res && res.error && res.error.code) || '');
      if (code === 'AUTH') { odAuthFail_(errBox); return; }
      /* PIN 오류는 **모달 안에서** 알린다 — 닫아 버리면 다시 열어 처음부터 해야 한다. */
      errBox.textContent = odErrorText_(code, res && res.error && res.error.message,
                                        '미점검으로 확정하지 못했습니다');
    });
  }

  function openReschedule_(o) {
    var data = state.payload || {};
    openModal_('재등록 — ' + o.project_name);
    var body = el_('dash-modal-body');
    body.textContent = '';
    body.appendChild(odMeta_(o));

    var form = document.createElement('div');
    form.className = 'dash-od-form';

    var sel = odActorSelect_(data, o.owner_id);
    form.appendChild(odField_('재등록하는 사람', sel));

    var date = document.createElement('input');
    date.type = 'date';
    date.id = 'dash-od-date';
    /* **과거는 못 고른다** — 고르는 순간 다시 미점검이 되어 버튼의 목적이 사라진다.
       서버도 같은 규칙으로 거절하지만, 누르기 전에 막는 편이 낫다. */
    date.min = todayStr_();
    date.value = todayStr_();
    form.appendChild(odField_('새 예정일', date));

    var pin = odPinInput_();
    form.appendChild(odField_('PIN', pin));

    body.appendChild(form);

    var err = odErrBox_();
    body.appendChild(err);

    var go = document.createElement('button');
    go.type = 'button';
    go.className = 'dash-btn dash-od-go';
    go.textContent = '재등록';
    go.addEventListener('click', function () {
      submitReschedule_(o, sel.value, date.value, pin.value, go, err);
    });
    body.appendChild(go);
  }

  /** 공사취소 제출 — 공사 자체가 없어져 점검할 것이 사라진 경우다. 서버는 기존 계획 취소
   *  (canceled)로 처리한다: '할 일이 없어졌다' 는 이미 그 상태의 뜻이다. */
  function submitWorkCancel_(o, real, pin, btn, errBox) {
    errBox.textContent = '';
    if (!real) { errBox.textContent = '취소하는 사람을 고르세요'; return; }
    if (!String(pin || '').length) { errBox.textContent = 'PIN 을 입력하세요'; return; }
    btn.disabled = true;
    btn.textContent = '취소 중...';
    requestJson(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'dash_plan_cancel', k: state.key,
        payload: { plan_id: o.plan_id, inspector_real_id: real, pin: pin } }),
      redirect: 'follow'
    }).then(function (res) {
      btn.disabled = false;
      btn.textContent = WORKCANCEL_LABEL;
      if (res && res.ok) {
        closeModal_();
        // 안내는 fetchDashboard 가 **커밋 뒤에** 띄운다 — 여기서 띄우면 같은 틱에 지워진다
        fetchDashboard('공사를 취소했습니다 — 목록에서 내렸습니다(미점검으로 세지 않습니다)');
        return;
      }
      var code = String((res && res.error && res.error.code) || '');
      if (code === 'AUTH') { odAuthFail_(errBox); return; }
      errBox.textContent = odErrorText_(code, res && res.error && res.error.message,
                                        '공사를 취소하지 못했습니다');
    });
  }

  /** 미점검확정 모달 — 사람 + PIN 뿐이다. **날짜 칸이 없다는 것이 이 기능의 정의다.**
   *  되돌릴 수 없는 쓰기라 무엇이 남고 무엇이 안 남는지를 누르기 전에 말한다 —
   *  "점검 처리" 로 오해하면 하지 않은 점검이 실적으로 둔갑한다. */
  function openUnchecked_(o) {
    var data = state.payload || {};
    openModal_(UNCHECK_LABEL + ' — ' + o.project_name);
    var body = el_('dash-modal-body');
    body.textContent = '';
    body.appendChild(odMeta_(o));

    var warn = document.createElement('p');
    warn.className = 'dash-od-warn';
    warn.textContent = '공사는 있었는데 점검하지 않았음을 확정합니다. 공사 목록에서 ' +
      '내려가고 점검 기록은 만들지 않습니다 — 누가 언제 확정했는지만 남습니다. ' +
      '공사 자체가 취소된 것이라면 「' + WORKCANCEL_LABEL + '」를 쓰세요. ' +
      '되돌리려면 계획을 새로 등록해야 합니다.';
    body.appendChild(warn);

    var form = document.createElement('div');
    form.className = 'dash-od-form';
    var sel = odActorSelect_(data, o.owner_id);
    form.appendChild(odField_('확정하는 사람', sel));
    var pin = odPinInput_();
    form.appendChild(odField_('PIN', pin));
    body.appendChild(form);

    var err = odErrBox_();
    body.appendChild(err);

    var go = document.createElement('button');
    go.type = 'button';
    go.className = 'dash-btn dash-od-go dash-od-danger';
    go.textContent = UNCHECK_LABEL;
    go.addEventListener('click', function () {
      submitUnchecked_(o, sel.value, pin.value, go, err);
    });
    body.appendChild(go);
  }

  /** 공사취소 모달 — 확정과 칸 구성은 같고 **뜻이 다르다**. 두 버튼이 나란히 있어 헷갈리기
   *  쉬우므로, 무엇이 아닌지를 경고에 먼저 적는다(점검을 못 한 것이면 미점검확정이다). */
  function openWorkCancel_(o) {
    var data = state.payload || {};
    openModal_(WORKCANCEL_LABEL + ' — ' + o.project_name);
    var body = el_('dash-modal-body');
    body.textContent = '';
    body.appendChild(odMeta_(o));

    var warn = document.createElement('p');
    warn.className = 'dash-od-warn dash-od-warn-mute';
    warn.textContent = '공사 자체가 취소돼 점검할 것이 없는 경우입니다. 목록에서 내려가고 ' +
      '미점검으로 세지 않습니다 — 점검을 못 한 것이라면 「' + UNCHECK_LABEL + '」을 쓰세요. ' +
      '되돌리려면 계획을 새로 등록해야 합니다.';
    body.appendChild(warn);

    var form = document.createElement('div');
    form.className = 'dash-od-form';
    var sel = odActorSelect_(data, o.owner_id);
    form.appendChild(odField_('취소하는 사람', sel));
    var pin = odPinInput_();
    form.appendChild(odField_('PIN', pin));
    body.appendChild(form);

    var err = odErrBox_();
    body.appendChild(err);

    var go = document.createElement('button');
    go.type = 'button';
    go.className = 'dash-btn dash-od-go dash-od-mute';
    go.textContent = WORKCANCEL_LABEL;
    go.addEventListener('click', function () {
      submitWorkCancel_(o, sel.value, pin.value, go, err);
    });
    body.appendChild(go);
  }

  function todayStr_() {
    var d = new Date();
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) +
           '-' + ('0' + d.getDate()).slice(-2);
  }

  /** 목록의 조치 버튼. 같은 글자('재등록')가 일곱 번 반복되므로 스크린리더용 이름에는
   *  공사명을 붙인다 — 안 붙이면 어느 건의 버튼인지 소리만 듣고는 알 수 없다. */
  function odActionBtn_(label, extraClass, o, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'dash-btn dash-od-btn' + (extraClass ? ' ' + extraClass : '');
    b.textContent = label;
    b.setAttribute('aria-label', label + ' — ' + o.project_name);
    b.addEventListener('click', onClick);
    return b;
  }

  /** 미점검 한 건 = **한 행**(사용자 지시 2026-08-19): 왼쪽에 내용, 오른쪽에 조치 둘.
   *  회사·예정일·경과·담당자는 한 줄로 접는다 — 카드 넉 줄짜리로 일곱 건이면 화면 세 장이었다.
   *  **공사명은 말줄임하지 않는다**: 이 목록의 주소는 끝자리만 다르다(184-4 / 184-7 / 180).
   *  잘라 버리면 서로 구별이 안 돼 어느 건을 누르는지 알 수 없다. */
  function overdueRow_(o) {
    var row = document.createElement('div');
    row.className = 'dash-od-row' + (o.days >= OD_STALE_DAYS ? ' dash-od-stale' : '');

    var text = document.createElement('div');
    text.className = 'dash-od-text';

    var nm = document.createElement('p');
    nm.className = 'dash-od-name';
    nm.textContent = o.project_name;
    text.appendChild(nm);

    /* 담당자 표시명이 **이미 팀을 품고 있으면** 팀을 또 붙이지 않는다 — 명부의 display 는
       '정수현(안전관리팀)' 같은 형식을 허용하고(gas/README 예시), 그때 '정수현(안전관리팀)
       (안전관리팀)' 이 됐다(2026-08-19 데모 캡처에서 발견). 표시명에 팀이 없는 명부에서는
       종전과 똑같이 '박종표(북부지사)' 로 나온다. */
    var who = String(o.owner || '');
    var team = String(o.team || '');
    if (team && who.indexOf('(' + team + ')') < 0) who += '(' + team + ')';
    var meta = document.createElement('p');
    meta.className = 'dash-od-meta';
    meta.textContent = o.company_name + ' · ' + o.planned_date + ' · ' + o.days + '일 경과' +
                       (who ? ' · ' + who : '');
    text.appendChild(meta);
    row.appendChild(text);

    var acts = document.createElement('div');
    acts.className = 'dash-od-acts';
    acts.appendChild(odActionBtn_('재등록', '', o, function () { openReschedule_(o); }));
    acts.appendChild(odActionBtn_(UNCHECK_LABEL, 'dash-od-danger', o,
                                  function () { openUnchecked_(o); }));
    /* 세 번째 조치는 **경보색이 아니다** — 공사취소는 우리가 놓친 것이 아니라 상황이 없어진
       것이다. 빨강을 두 개 두면 목록 전체가 경보로 보여 정작 미점검확정이 안 띈다. */
    acts.appendChild(odActionBtn_(WORKCANCEL_LABEL, 'dash-od-mute', o,
                                  function () { openWorkCancel_(o); }));
    row.appendChild(acts);
    return row;
  }

  function renderOverdue_(data) {
    /* 이 화면이 나오기 전에 저장된 payload 에는 overdue 가 없다 — 그때는 블록 자체를
       만들지 않는다(빈 목록으로 그리면 "밀린 게 없다"는 **거짓말**이 된다). */
    if (!data || !data.overdue) return null;
    var list = overdueFor_(data, state.view);
    var sec = document.createElement('section');
    sec.className = 'dash-block dash-overdue';
    var h = document.createElement('h2');
    h.textContent = '미점검 ' + list.length;
    sec.appendChild(h);

    var note = document.createElement('p');
    note.className = 'dash-modal-meta';
    note.textContent = list.length
      ? '예정일이 지나 현장 목록에서 내려간 계획입니다. 재등록하면 다시 작성할 수 있고, ' +
        '미점검확정은 점검하지 않았음을, 공사취소는 공사가 없어졌음을 남기고 목록에서 내립니다.'
      : '지난 예정 중 점검하지 않은 건이 없습니다.';
    sec.appendChild(note);
    list.forEach(function (o) { sec.appendChild(overdueRow_(o)); });
    return sec;
  }

  /** 현재 payload·view 로 본문 전체를 다시 그린다. */
  function renderView_() {
    var data = state.payload;
    var root = el_('dash-blocks');
    root.textContent = '';
    if (!data) return;
    el_('dash-generated').textContent = '기준 ' + data.generatedAt;
    var blocks = blocksFor_(data, state.view);
    if (blocks === null) {                     // 범위 오류 커밋(§4.1) — 사유만, 전환·CSV 비활성
      var p = document.createElement('p');
      p.className = 'dash-banner dash-banner-error';
      p.textContent = data.range.error;
      root.appendChild(p);
      el_('dash-team').disabled = true;
      return;
    }
    el_('dash-team').disabled = false;
    var od = renderOverdue_(data);             // 밀린 일이 먼저다 — 맨 위에 둔다
    if (od) root.appendChild(od);
    blocks.forEach(function (b) {
      var sec = renderBlock_(b);
      if (b.title.indexOf('협력회사별') === 0) appendCsvButton_(sec, b, '협력회사별');
      else if (b.title.indexOf('공사별') === 0) appendCsvButton_(sec, b, '공사별');
      root.appendChild(sec);
    });
    if (data.integrity && data.integrity.block) {
      var ig = renderBlock_(data.integrity.block);
      ig.className += ' dash-integrity';        // 경고 액센트(왼쪽 보더·제목색) — 배경은 그대로
      root.appendChild(ig);
    }
  }

  /** 팀 select 를 payload 로 다시 채운다(선택 유지). */
  function renderTeamSelect_() {
    var sel = el_('dash-team');
    sel.textContent = '';
    var data = state.payload;
    if (!data || data.range.error) return;
    teamOptions_(data).forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.text;
      sel.appendChild(opt);
    });
    if (state.view === null) sel.value = 'all';
    else {
      for (var i = 0; i < data.teams.length; i++) {
        if (data.teams[i].name === state.view) { sel.value = 't' + i; break; }
      }
    }
  }

  /** 팀 전환 — 재조회 없이 payload 에서 그린다(스펙 §3). 네트워크 호출 금지(D13 가드). */
  function onTeamChange_() {
    var v = el_('dash-team').value;
    if (v === 'all') state.view = null;
    else {
      var t = (state.payload && state.payload.teams[Number(v.slice(1))]) || null;
      state.view = t ? t.name : null;
    }
    renderView_();
  }

  function setBusy_(on) {
    el_('btn-dash-query').disabled = on;
    el_('btn-dash-refresh').disabled = on;
  }

  /** okMsg: 쓰기(재등록·미점검확정)가 성공한 직후의 안내. **이 함수가 띄운다.**
   *  호출부에서 showBanner_ 로 띄우면 아래 showBanner_('') 가 **같은 틱에** 지워 사용자는
   *  아무것도 못 본다(2026-08-19 디버깅 실측 — 재등록도 도입 때부터 같은 결함이었다).
   *  미점검확정은 되돌릴 수 없는데 확인이 없으면 눌리기는 했는지도 모른다.
   *
   *  **문자열이 아니면 무시한다** — 새로고침·조회 버튼이 이 함수를 리스너로 그대로 쓴다
   *  (addEventListener('click', fetchDashboard)). 안 걸러 내면 click 이벤트 객체가 배너 문구가 된다. */
  function fetchDashboard(okMsg) {
    var ok = (typeof okMsg === 'string') ? okMsg : '';
    if (!state.key) { showKeyScreen_(''); return; }
    var g = beginQuery_(state);
    var url = CONFIG.API_URL + '?action=dashboard&k=' + encodeURIComponent(state.key);
    var from = el_('dash-from').value, to = el_('dash-to').value;
    if (from || to) url += '&from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to);
    setBusy_(true);
    showBanner_('');
    requestJson(url, null).then(function (res) {
      var verdict = applyResult_(state, g, res);
      if (verdict === 'stale') return;         // 더 새 요청이 있다 — 그쪽이 화면을 맡는다
      setBusy_(false);
      if (verdict === 'committed') {
        closeModal_();                         // 커밋 = 화면 통째 교체 — 옛 조건의 팝업·진행 중 상세도 함께 무효(적대 리뷰 #3)
        persistLast_(state.payload);
        showBanner_(ok);                       // '' 면 복원 안내(저장된 화면…)를 걷는 기존 동작
        renderTeamSelect_();
        renderView_();
        return;
      }
      var msg = (res && res.error && res.error.message) || '';
      if (verdict === 'auth') { hardReset_('키가 맞지 않습니다 — 다시 입력하세요'); return; }
      /* 쓰기는 성공했는데 갱신만 실패한 경우 — **둘 다** 말한다. 실패만 말하면 쓰기까지
         실패한 줄 알고 다시 누른다(재등록이면 날짜를 또 잡는다). */
      function withOk(err) { return ok ? ok + ' — 다만 ' + err : err; }
      if (verdict === 'config') { showBanner_(withOk('서버 설정 문제 — 관리자에게 문의 (' + msg + ')'), true); return; }
      /* transient — 마지막 성공 화면 유지 + 배너(K2·K3). 커밋하지 않았다(§4.1). */
      var base = state.payload ? '마지막 성공 기준 ' + state.payload.generatedAt : '표시할 데이터 없음';
      showBanner_(withOk('동기화 실패 — ' + base + ' · ' + msg + ' — 다시 조회를 누르세요'), true);
    });
  }

  function onKeySave_() {
    var v = el_('dash-key-input').value.trim();
    if (!v) return;
    state.key = v;
    try { localStorage.setItem(KEY_STORE, v); } catch (e) { /* 저장 실패해도 이번 세션은 동작 */ }
    showMainScreen_();
    showBanner_('');
    fetchDashboard();
  }

  function init_() {
    var saved = '';
    try { saved = localStorage.getItem(KEY_STORE) || ''; } catch (e) { saved = ''; }
    el_('btn-dash-keysave').addEventListener('click', onKeySave_);
    el_('dash-key-input').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') onKeySave_();
    });
    el_('btn-dash-query').addEventListener('click', fetchDashboard);
    el_('btn-dash-refresh').addEventListener('click', fetchDashboard);
    el_('btn-dash-monthly').addEventListener('click', openMonthly_);
    el_('btn-dash-clearkey').addEventListener('click', function () {
      hardReset_('저장된 키를 지웠습니다');
    });
    el_('dash-team').addEventListener('change', onTeamChange_);
    var theme = '';
    try { theme = localStorage.getItem(THEME_STORE) || ''; } catch (e) { theme = ''; }
    applyTheme_(theme);
    el_('btn-dash-theme').addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'dark' ? '' : 'dark';
      applyTheme_(next);
      try {
        if (next) localStorage.setItem(THEME_STORE, next);
        else localStorage.removeItem(THEME_STORE);
      } catch (e) { /* 저장 실패해도 이번 세션은 적용됨 */ }
    });
    el_('btn-dash-modal-close').addEventListener('click', closeModal_);
    el_('dash-modal-back').addEventListener('click', closeModal_);
    el_('btn-dash-modal-back').addEventListener('click', function () {
      if (!modal.list) return;
      openModal_(modal.listTitle);
      renderSubs_(modal.list, modal.listExpected);   // 캐시에서 — 재조회 없음
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && !el_('dash-modal').hidden) closeModal_();
    });
    window.addEventListener('popstate', function () {
      /* 뒤로가기: 팝업이 열려 있으면 그 한 번은 팝업 닫기다 — 히스토리 칸은 이미 소비됐다 */
      if (!el_('dash-modal').hidden) {
        modal.hasHistory = false;
        closeModal_();
      }
    });
    if (saved) {
      state.key = saved;
      showMainScreen_();
      var last = restoreLast_();
      if (last) {
        /* gen 을 통하지 않은 로컬 복원 — 진행 중 조회와 경쟁하지 않는다(§4.1:
           최신 커밋이 도착하면 통째로 교체된다). 드릴다운도 committedRange 로 즉시 가능. */
        state.payload = last;
        state.committedRange = last.range;
        renderTeamSelect_();
        renderView_();
      }
      fetchDashboard();
      if (last) showBanner_('저장된 화면 (기준 ' + String(last.generatedAt || '') + ') — 최신 데이터 조회 중…');
    } else {
      showKeyScreen_('');
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init_);
  else init_();
})();
