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

  /** 키 지우기·AUTH 의 DOM 쪽 절반 — resetKey_(상태) 와 항상 함께 부른다. */
  function hardReset_(msg) {
    resetKey_(state);
    try { localStorage.removeItem(KEY_STORE); } catch (e) { /* 프라이빗 모드 등 — 상태는 이미 비웠다 */ }
    wipeData_();
    showKeyScreen_(msg);
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
      block.rows.forEach(function (row) {
        var tr = document.createElement('tr');
        row.forEach(function (cell, i) {
          var td = document.createElement('td');
          td.textContent = String(cell);
          var cls = numCols[i] ? 'dash-num' : '';
          if (i === dangerCol && Number(cell) > 0) cls += (cls ? ' ' : '') + 'dash-danger';
          if (cls) td.className = cls;
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      wrap.appendChild(table);
      sec.appendChild(wrap);
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
