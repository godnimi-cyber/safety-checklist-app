/* dashboard.js — 웹 대시보드 (스펙 docs/superpowers/specs/2026-08-07-web-dashboard-design.md rev.3)
 * ES5 · 제로 의존성 · app.js 를 로드하지 않는 독립 페이지.
 * CONFIG 는 API_URL 만 쓴다 — SHARED_KEY 는 절대 읽지 않는다(스펙 §7). */
(function () {
  'use strict';

  var KEY_STORE = 'safety_dash_key';

  /* ---------- 상태 (스펙 §4.1) ----------
     렌더·CSV 는 payload·committedRange 만 본다. gen 은 요청 세대 — 최신 세대가 아닌
     응답은 도착해도 버린다(늦은 응답 역전·키 삭제 후 부활 방지).
     view: null=전체, 문자열=팀 name(빈 문자열 '(팀 없음)' 포함 — null 과 '' 는 다르다). */
  var state = { key: '', gen: 0, payload: null, committedRange: null, view: null };

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
  function teamOptions_(data) {
    var out = [{ value: 'all', text: '전체 (' + data.all.count + ')' }];
    data.teams.forEach(function (t, i) {
      out.push({ value: 't' + i, text: t.label + ' (' + t.count + ')' });
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
    try { localStorage.removeItem(KEY_STORE); } catch (e) { /* 프라이빗 모드 등 — 상태는 이미 비웠다 */ }
    wipeData_();
    showKeyScreen_(msg);
  }

  /* ---------- 드릴다운 모달 — 공사별 점검·부적합 팝업 (2026-08-08 확장) ----------
     상세는 커밋된 조건(committedRange·현재 팀)만으로 서버에 묻는다(§4.1 규칙 그대로).
     modal.gen 은 모달 전용 세대 — 닫히거나 새 요청이 시작되면 늦은 응답을 버린다. */

  var modal = { gen: 0, list: null, listTitle: '', listExpected: undefined };

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
    el_('dash-modal-title').textContent = title;
    el_('dash-modal-body').textContent = '';
    el_('btn-dash-modal-back').hidden = true;
    el_('dash-modal').hidden = false;
  }

  function closeModal_() {
    modal.gen += 1;                            // 진행 중 상세 응답 무효화
    modal.list = null;
    modal.listTitle = '';
    modal.listExpected = undefined;
    el_('dash-modal').hidden = true;
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

  function fetchDetail_(kind, key, extra, render) {
    var g = ++modal.gen;
    modalMsg_('불러오는 중', false);
    requestJson(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'dashboard_detail', k: state.key,
                             payload: detailPayload_(state, kind, key, extra) }),
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
      retry.addEventListener('click', function () { fetchDetail_(kind, key, extra, render); });
      el_('dash-modal-body').appendChild(retry);
    });
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

  function fetchDashboard() {
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
        renderTeamSelect_();
        renderView_();
        return;
      }
      var msg = (res && res.error && res.error.message) || '';
      if (verdict === 'auth') { hardReset_('키가 맞지 않습니다 — 다시 입력하세요'); return; }
      if (verdict === 'config') { showBanner_('서버 설정 문제 — 관리자에게 문의 (' + msg + ')', true); return; }
      /* transient — 마지막 성공 화면 유지 + 배너(K2·K3). 커밋하지 않았다(§4.1). */
      var base = state.payload ? '마지막 성공 기준 ' + state.payload.generatedAt : '표시할 데이터 없음';
      showBanner_('동기화 실패 — ' + base + ' · ' + msg + ' — 다시 조회를 누르세요', true);
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
    el_('btn-dash-clearkey').addEventListener('click', function () {
      hardReset_('저장된 키를 지웠습니다');
    });
    el_('dash-team').addEventListener('change', onTeamChange_);
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
    if (saved) {
      state.key = saved;
      showMainScreen_();
      fetchDashboard();
    } else {
      showKeyScreen_('');
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init_);
  else init_();
})();
