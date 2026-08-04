/* safety-checklist — app.js: DOM 배선 전용. 검증/파생 로직은 SafetyLib·SafetyLogic 호출만 한다.
   화면: 홈(home) / 작성(write, step1 헤더 · step2 항목) / 검토(review). */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /* ---------- MOCK masters (CONFIG.MOCK=true 일 때 fetch 대신 사용, 개발·데모용) ---------- */
  var MOCK_MASTERS = {
    companies: [
      { company_id: 'MC1', name: '(주)한빛건설', active: true },
      { company_id: 'MC2', name: '대성설비', active: true }
    ],
    projects: [
      { project_id: 'MP1', name: '본관 3층 배관교체 공사', company_id: 'MC1', status: '진행' },
      { project_id: 'MP2', name: '옥외 변전실 증설 공사', company_id: 'MC2', status: '진행' }
    ],
    inspectors: [
      { inspector_id: 'MI1', team: '안전관리팀', name: '정수현', display: '정수현(안전관리팀)', active: true },
      { inspector_id: 'MI2', team: '시설팀', name: '한도윤', display: '한도윤(시설팀)', active: true }
    ],
    templates: [{
      template_id: 'MOCK', name: '모바일 데모 점검표', ver: 1, active: true,
      items: [
        { item_id: 'MOCK-001', type: 'group', seq: 1, category: '안전보호구', text: '안전보호구를 반드시 착용한다.', criteria: '안전모·안전화·안전대 착용 여부 확인' },
        { item_id: 'MOCK-002', type: 'item', seq: 2, category: '안전보호구', text: '보호구 상태 확인', criteria: '파손·노후 여부 육안 점검' },
        { item_id: 'MOCK-003', type: 'note', seq: 3, category: '안전보호구', text: '고소작업 시 안전대는 2개 걸이 이상 사용한다.', criteria: '' },
        { item_id: 'MOCK-004', type: 'group', seq: 4, category: '화기작업', text: '화기작업 허가서 확인 후 작업한다.', criteria: '허가서 승인 여부 확인' },
        { item_id: 'MOCK-005', type: 'item', seq: 5, category: '화기작업', text: '소화기 비치 확인', criteria: '작업 반경 5m 이내 소화기 배치' },
        { item_id: 'MOCK-006', type: 'item', seq: 6, category: '화기작업', text: '화재감시자 배치 확인', criteria: '화재감시자 지정 및 상주 여부' }
      ]
    }],
    rev: 1
  };

  /* ---------- state ---------- */
  var state = {
    storage: null,
    masters: null,
    mastersSyncedAt: null,
    masterBanner: null,
    draft: null,
    queue: [],
    currentScreen: 'home',
    writeStep: 1,
    syncing: false,
    submitting: false,
    banner: null
  };

  /* ---------- 유틸 ---------- */
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function formatDateTime(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
  function chevronNode() {
    var span = document.createElement('span');
    span.className = 'chevron';
    span.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    return span;
  }
  function closeIconMarkup() {
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  }
  function placeholderOption(label) {
    var opt = document.createElement('option');
    opt.value = ''; opt.textContent = label; opt.disabled = true; opt.selected = true;
    return opt;
  }
  function companyName(id) {
    var c = state.masters && (state.masters.companies || []).filter(function (x) { return x.company_id === id; })[0];
    return c ? c.name : (id || '');
  }
  function projectName(key) {
    var p = state.masters && (state.masters.projects || []).filter(function (x) { return x.project_id === key; })[0];
    return p ? p.name : (key || '');
  }
  function inspectorDisplay(id) {
    var i = state.masters && (state.masters.inspectors || []).filter(function (x) { return x.inspector_id === id; })[0];
    return i ? i.display : (id || '');
  }
  function teamOf(inspectorId) {
    var i = state.masters && (state.masters.inspectors || []).filter(function (x) { return x.inspector_id === inspectorId; })[0];
    return i ? i.team : '';
  }
  function getCurrentTemplateItems() {
    if (!state.masters || !state.draft) return [];
    var tpl = (state.masters.templates || []).filter(function (t) { return t.template_id === state.draft.template_id; })[0];
    return tpl ? tpl.items : [];
  }
  function withInjectedPin(masters, inspectorId, pin) {
    /* masters 응답에는 pin이 없다 — 클라 사전검증이 PIN_MISMATCH로 오탐하지 않도록
       선택된 점검자에게만 draft.pin을 주입한 사본을 만든다. 서버가 실제 PIN을 재검증한다. */
    var copy = {};
    Object.keys(masters).forEach(function (k) { copy[k] = masters[k]; });
    copy.inspectors = (masters.inspectors || []).map(function (i) {
      if (i.inspector_id !== inspectorId) return i;
      var withPin = {}; Object.keys(i).forEach(function (k) { withPin[k] = i[k]; });
      withPin.pin = pin;
      return withPin;
    });
    return copy;
  }
  /* 큐 항목에만 붙는 로컬 메타(서버로 보내지 않는다) — 새 키를 추가하면 반드시 여기에도 넣어라 */
  var QUEUE_META_KEYS = ['state', 'reason', 'reason_message'];
  function stripQueueMeta(item) {
    var copy = {};
    Object.keys(item).forEach(function (k) { if (QUEUE_META_KEYS.indexOf(k) === -1) copy[k] = item[k]; });
    return copy;
  }
  /* 큐 행 '상세'에 보여줄 payload — PIN 은 화면에 그대로 띄우지 않는다(내용 확인에 불필요) */
  function queuePayloadPreview(item) {
    var view = stripQueueMeta(item);
    if (Object.prototype.hasOwnProperty.call(view, 'pin')) view.pin = '****';
    return JSON.stringify(view, null, 2);
  }
  /* 오류 코드 분류(계약 C1):
       영구(permanent) = AUTH·VALIDATION — 같은 payload 를 다시 보내도 절대 성공하지 않는다 → 자동 재시도 금지
       일시(retryable) = NETWORK·LOCK_TIMEOUT·SERVER(그 외 전부) — 재시도로 성공할 수 있다 */
  var PERMANENT_ERROR_CODES = ['AUTH', 'VALIDATION'];
  function isPermanentError(code) {
    return PERMANENT_ERROR_CODES.indexOf(String(code || '').toUpperCase()) !== -1;
  }
  function normalizeError(error) {
    return {
      code: (error && error.code) || 'SERVER',
      message: (error && error.message) || '알 수 없는 오류'
    };
  }
  /* FAILED 는 code(reason)만 남긴다 — 사람이 읽을 message 까지 큐 행에 보존한다. */
  function markQueueFailure(id, error) {
    state.queue = SafetyLogic.queueReducer(state.queue, { type: 'FAILED', id: id, reason: error.code });
    state.queue = state.queue.map(function (q) {
      if (q.submission_id !== id) return q;
      var updated = {};
      Object.keys(q).forEach(function (k) { updated[k] = q[k]; });
      updated.reason_message = error.message || '';
      return updated;
    });
  }
  function persistDraft() {
    if (state.draft) state.storage.saveDraft(state.draft);
  }
  function invalidateAck() {
    /* 제출 내용(1단계 기본정보 + 2단계 응답) 중 무엇이든 검토 확인 이후 바뀌면 이전 확인은 무효 —
       재확인을 강제해 "확인 시점 ≠ 실제 제출 내용" 무결성 갭을 막는다.
       특히 수검자·점검자가 바뀌면 "누가 무엇을 확인했는가" 자체가 달라진다. */
    if (!state.draft) return;
    state.draft.auditee_ack = false;
    state.draft.auditee_ack_at = '';
  }

  /* ---------- 네트워크 (fetch 규약 verbatim, 설계 §5.2) ---------- */
  function loadMastersFromNetwork() {
    return CONFIG.MOCK ? mockMasters() : fetchMastersRemote();
  }
  function fetchMastersRemote() {
    var url = CONFIG.API_URL + '?action=masters&k=' + CONFIG.SHARED_KEY;
    return fetch(url).then(function (res) {
      return res.json().catch(function () {
        return { ok: false, error: { code: 'NETWORK', message: '마스터 응답을 해석할 수 없습니다' } };
      });
    }, function () {
      return { ok: false, error: { code: 'NETWORK', message: '네트워크 오류' } };
    }).catch(function (err) {
      return { ok: false, error: { code: 'NETWORK', message: (err && err.message) || '네트워크 오류' } };
    });
  }
  function mockMasters() {
    return new Promise(function (resolve) {
      setTimeout(function () { resolve({ ok: true, data: MOCK_MASTERS }); }, 150);
    });
  }
  function submitToServer(payload) {
    return CONFIG.MOCK ? mockSubmit(payload) : realSubmit(payload);
  }
  function realSubmit(payload) {
    return fetch(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'submit', k: CONFIG.SHARED_KEY, payload: payload }),
      redirect: 'follow'
    }).then(function (res) {
      return res.json().catch(function () {
        return { ok: false, error: { code: 'NETWORK', message: '서버 응답을 해석할 수 없습니다(비-JSON)' } };
      });
    }, function () {
      return { ok: false, error: { code: 'NETWORK', message: '네트워크 오류' } };
    }).catch(function (err) {
      return { ok: false, error: { code: 'NETWORK', message: (err && err.message) || '네트워크 오류' } };
    });
  }
  function mockSubmit(payload) {
    // eslint-disable-next-line no-console
    console.log('[MOCK submit]', payload);
    return new Promise(function (resolve) {
      setTimeout(function () {
        resolve({ ok: false, error: { code: 'MOCK', message: 'MOCK 모드 — 서버 미연결(큐에 보관됨)' } });
      }, 300);
    });
  }

  /* ---------- 배너 ---------- */
  function showBanner(level, text) {
    state.banner = { level: level, text: text };
    renderBanner();
  }
  function clearBanner() {
    state.banner = null;
    renderBanner();
  }
  function renderBanner() {
    var region = $('banner-region');
    region.innerHTML = '';
    if (!state.banner) return;
    var el = document.createElement('div');
    el.className = 'banner banner-' + state.banner.level;
    var span = document.createElement('span');
    span.className = 'banner-text';
    span.textContent = state.banner.text;
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'banner-close';
    closeBtn.setAttribute('aria-label', '알림 닫기');
    closeBtn.innerHTML = closeIconMarkup();
    closeBtn.addEventListener('click', clearBanner);
    el.appendChild(span);
    el.appendChild(closeBtn);
    region.appendChild(el);
  }
  function renderMasterBanner() {
    var el = $('home-master-banner');
    if (!state.masterBanner) { el.hidden = true; return; }
    el.hidden = false;
    el.className = 'banner banner-' + state.masterBanner.level;
    el.textContent = state.masterBanner.text;
  }

  /* ---------- 화면 전환 ---------- */
  function show(name) {
    state.currentScreen = name;
    $('screen-home').hidden = name !== 'home';
    $('screen-write').hidden = name !== 'write';
    $('screen-review').hidden = name !== 'review';
    updateTopbar(name);
    if (name === 'home') { renderHome(); flushQueue(); }
    else if (name === 'write') { renderWrite(); }
    else if (name === 'review') { renderReview(); }
    window.scrollTo(0, 0);
  }
  function updateTopbar(name) {
    var title = $('topbar-title');
    var back = $('btn-back');
    if (name === 'home') { title.textContent = '안전점검'; back.hidden = true; }
    else if (name === 'write') { title.textContent = state.writeStep === 1 ? '작성 · 기본정보' : '작성 · 항목점검'; back.hidden = false; }
    else if (name === 'review') { title.textContent = '검토'; back.hidden = false; }
  }
  function onBack() {
    if (state.submitting) return; /* 제출 진행 중 화면 이탈 금지 — 완료 전 draft가 다른 화면 편집으로 덮이는 경합 방지 */
    if (state.currentScreen === 'review') { state.writeStep = 2; show('write'); return; }
    if (state.currentScreen === 'write') {
      if (state.writeStep === 2) { state.writeStep = 1; show('write'); }
      else { show('home'); }
    }
  }

  /* ================= 홈 ================= */
  function renderHome() {
    $('home-sync-line').textContent = state.mastersSyncedAt
      ? ('마스터 동기화: ' + formatDateTime(state.mastersSyncedAt))
      : '마스터 동기화 안 됨';
    renderMasterBanner();

    var list = $('home-template-list');
    list.innerHTML = '';
    /* companies/inspectors와 동일한 방어적 대칭 — 서버(gas/main.gs loadMasters_)는 이미
       active=TRUE 템플릿만 내려보내지만, MOCK 경로는 서버를 거치지 않으므로 클라에서도 필터링한다. */
    var templates = ((state.masters && state.masters.templates) || []).filter(function (t) { return t.active !== false; });
    if (!templates.length) {
      var p = document.createElement('p');
      p.className = 'muted';
      p.textContent = state.masters ? '등록된 활성 양식이 없습니다.' : '마스터를 불러오지 못해 새 점검을 시작할 수 없습니다.';
      list.appendChild(p);
    } else {
      templates.forEach(function (t) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-primary btn-block template-btn';
        btn.textContent = '새 점검 시작 — ' + (t.name || t.template_id);
        btn.addEventListener('click', function () { startNewInspection(t); });
        list.appendChild(btn);
      });
    }

    var contWrap = $('home-continue-wrap');
    if (state.draft) {
      contWrap.hidden = false;
      var tpl = (state.masters && state.masters.templates || []).filter(function (t) { return t.template_id === state.draft.template_id; })[0];
      $('home-continue-label').textContent = '작성 중: ' + (tpl ? tpl.name : state.draft.template_id) + ' (' + state.draft.inspect_date + ')';
    } else {
      contWrap.hidden = true;
    }

    var badge = $('home-queue-badge');
    var count = state.queue.length;
    badge.textContent = String(count);
    badge.hidden = count === 0;
    $('home-queue-empty').hidden = count !== 0;
    var syncBtn = $('btn-sync-now');
    syncBtn.disabled = state.syncing || count === 0;
    renderQueueList();
  }
  function renderQueueList() {
    var wrap = $('home-queue-list');
    wrap.innerHTML = '';
    state.queue.forEach(function (q) {
      var node = $('tpl-queue-row').content.firstElementChild.cloneNode(true);
      node.querySelector('.queue-title').textContent = (q.template_id || '') + ' · ' + (q.inspect_date || '');
      node.querySelector('.queue-sub').textContent = companyName(q.company_id) + ' · ' + (q.project_name || projectName(q.project_key));
      var stateEl = node.querySelector('.queue-state');
      if (q.state === 'failed') {
        var detail = (q.reason || '') + (q.reason_message ? ' — ' + q.reason_message : '');
        /* 영구 실패는 자동 재시도 대상이 아니다 — "언젠간 전송되겠지"라는 오해를 문구로 끊는다 */
        stateEl.textContent = isPermanentError(q.reason)
          ? ('전송 불가 (자동 재시도 안 함) — ' + detail)
          : ('재전송 대기 — 실패(' + detail + ')');
        stateEl.classList.add('text-danger');
      } else {
        stateEl.textContent = '전송 대기 중';
        stateEl.classList.add('text-neutral');
      }

      /* 상세: 갇힌 항목의 내용을 읽을 수 있게 (textContent 로만 — innerHTML 금지) */
      var detailBtn = node.querySelector('.queue-btn-detail');
      var payloadEl = node.querySelector('.queue-payload');
      payloadEl.textContent = queuePayloadPreview(q);
      detailBtn.addEventListener('click', function () {
        var willShow = payloadEl.hidden;
        payloadEl.hidden = !willShow;
        detailBtn.setAttribute('aria-expanded', willShow ? 'true' : 'false');
        detailBtn.textContent = willShow ? '상세 닫기' : '상세';
      });

      /* 삭제: 큐에 갇힌 항목의 유일한 탈출구. 전송 중에는 경합을 피해 잠근다. */
      var deleteBtn = node.querySelector('.queue-btn-delete');
      deleteBtn.disabled = state.syncing;
      deleteBtn.addEventListener('click', function () {
        var ok = window.confirm('이 미전송 항목을 큐에서 삭제합니다. 삭제하면 복구할 수 없고 서버에도 전송되지 않습니다. 계속할까요?');
        if (!ok) return;
        state.queue = state.queue.filter(function (x) { return x.submission_id !== q.submission_id; });
        state.storage.saveQueue(state.queue);
        renderHome();
      });

      wrap.appendChild(node);
    });
  }
  function startNewInspection(template) {
    if (state.draft) {
      var ok = window.confirm('작성 중인 임시 점검이 있습니다. 새로 시작하면 기존 임시 점검은 삭제됩니다. 계속할까요?');
      if (!ok) return;
    }
    state.draft = SafetyLogic.newDraft(template.template_id, template.ver, todayStr());
    state.storage.saveDraft(state.draft);
    state.writeStep = 1;
    clearBanner();
    show('write');
  }
  function continueDraft() {
    if (!state.draft) return;
    state.writeStep = 2;
    clearBanner();
    show('write');
  }
  function flushQueue() {
    if (state.syncing) return Promise.resolve();
    /* 영구 실패(AUTH·VALIDATION)는 재전송해도 같은 결과다 — 무한 재시도를 여기서 끊는다.
       사용자는 큐 행의 '상세'로 내용을 확인하고 '삭제'로 정리한다. */
    var targets = state.queue.filter(function (q) {
      if (q.state === 'pending') return true;
      return q.state === 'failed' && !isPermanentError(q.reason);
    });
    if (!targets.length) return Promise.resolve();
    state.syncing = true;
    renderHome();
    var chain = Promise.resolve();
    targets.forEach(function (item) {
      chain = chain.then(function () {
        var payload = stripQueueMeta(item);
        return submitToServer(payload).then(function (result) {
          if (result.ok) {
            state.queue = SafetyLogic.queueReducer(state.queue, { type: 'SENT', id: payload.submission_id });
          } else {
            markQueueFailure(payload.submission_id, normalizeError(result.error));
          }
          state.storage.saveQueue(state.queue);
        });
      });
    });
    return chain.then(function () {
      state.syncing = false;
      if (state.currentScreen === 'home') renderHome();
    });
  }

  /* ================= 작성 ================= */
  function renderWrite() {
    if (!state.draft) { show('home'); return; }
    var isStep2 = state.writeStep === 2;
    $('write-step1').hidden = isStep2;
    $('write-step2').hidden = !isStep2;
    $('write-step1-actions').hidden = isStep2;
    $('write-step2-actions').hidden = !isStep2;
    $('write-progress-bar').hidden = !isStep2;
    if (isStep2) buildStep2();
    else renderWriteStep1();
    updateTopbar('write');
  }

  function renderWriteStep1() {
    var draft = state.draft;
    $('f-date').value = draft.inspect_date || todayStr();
    $('f-date').max = todayStr();

    populateCompanySelect();
    $('f-company').value = draft.company_id || '';
    populateProjectSelect(draft.company_id);
    if (/^TMP-/.test(draft.project_key || '')) {
      $('f-project').value = '__TMP__';
      $('f-project-tmp-wrap').hidden = false;
      $('f-project-tmp').value = draft.project_name || '';
    } else {
      $('f-project').value = draft.project_key || '';
      $('f-project-tmp-wrap').hidden = true;
    }

    populateTeamSelect();
    var team = teamOf(draft.inspector_id);
    $('f-team').value = team || '';
    populateInspectorSelect(team);
    $('f-inspector').value = draft.inspector_id || '';

    $('f-pin').value = draft.pin || '';
    $('f-auditee').value = draft.auditee || '';
  }
  function populateCompanySelect() {
    var sel = $('f-company');
    sel.innerHTML = '';
    sel.appendChild(placeholderOption('협력회사 선택'));
    ((state.masters && state.masters.companies) || []).filter(function (c) { return c.active !== false; })
      .forEach(function (c) {
        var opt = document.createElement('option');
        opt.value = c.company_id; opt.textContent = c.name;
        sel.appendChild(opt);
      });
  }
  function populateProjectSelect(companyId) {
    var sel = $('f-project');
    sel.innerHTML = '';
    sel.appendChild(placeholderOption('공사 선택'));
    ((state.masters && state.masters.projects) || [])
      .filter(function (p) { return p.company_id === companyId && p.status === '진행'; })
      .forEach(function (p) {
        var opt = document.createElement('option');
        opt.value = p.project_id; opt.textContent = p.name;
        sel.appendChild(opt);
      });
    var tmpOpt = document.createElement('option');
    tmpOpt.value = '__TMP__'; tmpOpt.textContent = '미등록 공사(직접 입력)';
    sel.appendChild(tmpOpt);
    sel.disabled = !companyId;
  }
  function populateTeamSelect() {
    var sel = $('f-team');
    sel.innerHTML = '';
    sel.appendChild(placeholderOption('소속팀 선택'));
    var teams = [];
    ((state.masters && state.masters.inspectors) || []).forEach(function (i) {
      if (i.active !== false && teams.indexOf(i.team) === -1) teams.push(i.team);
    });
    teams.sort();
    teams.forEach(function (t) {
      var opt = document.createElement('option');
      opt.value = t; opt.textContent = t;
      sel.appendChild(opt);
    });
  }
  function populateInspectorSelect(team) {
    var sel = $('f-inspector');
    sel.innerHTML = '';
    sel.appendChild(placeholderOption('점검자 선택'));
    sel.disabled = !team;
    ((state.masters && state.masters.inspectors) || [])
      .filter(function (i) { return i.team === team && i.active !== false; })
      .forEach(function (i) {
        var opt = document.createElement('option');
        opt.value = i.inspector_id; opt.textContent = i.display;
        sel.appendChild(opt);
      });
  }

  /* 1단계 기본정보 변경도 2단계 응답과 똑같이 확인(ack)을 무효화한다 —
     검토에서 확인한 뒤 되돌아와 수검자·점검자를 바꾸면 옛 확인 시각이 그대로 붙어 기록이 왜곡된다. */
  function onCompanyChange(e) {
    state.draft.company_id = e.target.value;
    state.draft.project_key = '';
    state.draft.project_name = '';
    populateProjectSelect(e.target.value);
    $('f-project-tmp-wrap').hidden = true;
    invalidateAck();
    persistDraft();
  }
  function onProjectChange(e) {
    var v = e.target.value;
    var tmpWrap = $('f-project-tmp-wrap');
    if (v === '__TMP__') {
      tmpWrap.hidden = false;
      if (!/^TMP-/.test(state.draft.project_key || '')) state.draft.project_key = 'TMP-' + SafetyLogic.uuid();
      state.draft.project_name = $('f-project-tmp').value || '';
    } else {
      tmpWrap.hidden = true;
      state.draft.project_key = v;
      state.draft.project_name = projectName(v);
    }
    invalidateAck();
    persistDraft();
  }
  function onProjectTmpInput(e) {
    state.draft.project_name = e.target.value;
    invalidateAck();
    persistDraft();
  }
  function onTeamChange(e) {
    populateInspectorSelect(e.target.value);
    state.draft.inspector_id = '';
    invalidateAck();
    persistDraft();
  }
  function onInspectorChange(e) {
    state.draft.inspector_id = e.target.value;
    invalidateAck();
    persistDraft();
  }
  function onPinInput(e) {
    var digits = e.target.value.replace(/\D/g, '').slice(0, 4);
    e.target.value = digits;
    state.draft.pin = digits;
    invalidateAck();
    persistDraft();
  }
  function onDateChange(e) {
    state.draft.inspect_date = e.target.value;
    invalidateAck();
    persistDraft();
  }
  function onAuditeeInput(e) {
    state.draft.auditee = e.target.value;
    invalidateAck();
    persistDraft();
  }
  function onStep1Next() {
    var d = state.draft, missing = [];
    if (!d.inspect_date) missing.push('점검일');
    if (!d.company_id) missing.push('협력회사');
    if (!d.project_key || (/^TMP-/.test(d.project_key) && !(d.project_name && d.project_name.trim()))) missing.push('공사');
    if (!d.inspector_id) missing.push('점검자');
    if (!/^\d{4}$/.test(d.pin || '')) missing.push('PIN(4자리)');
    if (!(d.auditee && d.auditee.trim())) missing.push('수검자');
    if (missing.length) { showBanner('error', '다음 항목을 확인하세요: ' + missing.join(', ')); return; }
    clearBanner();
    state.writeStep = 2;
    show('write');
  }

  /* ---------- 작성 2단계: 항목 아코디언 ---------- */
  function buildStep2() {
    var root = $('accordion-root');
    root.innerHTML = '';
    var items = getCurrentTemplateItems();
    if (!items.length) {
      var p = document.createElement('p');
      p.className = 'muted';
      p.textContent = '이 양식에 등록된 항목이 없습니다.';
      root.appendChild(p);
      updateProgressBar();
      return;
    }
    var sorted = items.slice().sort(function (a, b) { return a.seq - b.seq; });
    var groups = [], indexOf = {};
    sorted.forEach(function (it) {
      var cat = it.category || '기타';
      if (!(cat in indexOf)) { indexOf[cat] = groups.length; groups.push({ name: cat, items: [] }); }
      groups[indexOf[cat]].items.push(it);
    });
    groups.forEach(function (group) {
      var details = document.createElement('details');
      details.className = 'category';
      details.open = true;
      var summary = document.createElement('summary');
      summary.className = 'category-summary';
      var titleSpan = document.createElement('span');
      titleSpan.className = 'category-title';
      titleSpan.textContent = group.name;
      var chip = document.createElement('span');
      chip.className = 'cat-chip';
      summary.appendChild(titleSpan);
      summary.appendChild(chip);
      summary.appendChild(chevronNode());
      details.appendChild(summary);
      var body = document.createElement('div');
      body.className = 'category-body';
      group.items.forEach(function (it) {
        body.appendChild(it.type === 'note' ? buildNoteBox(it) : buildItemCard(it));
      });
      details.appendChild(body);
      root.appendChild(details);
      updateCategoryChip(details);
    });
    updateProgressBar();
  }
  function buildNoteBox(it) {
    var node = $('tpl-note-box').content.firstElementChild.cloneNode(true);
    node.querySelector('.note-box-text').textContent = it.criteria ? (it.text + ' — ' + it.criteria) : it.text;
    return node;
  }
  function buildItemCard(it) {
    var node = $('tpl-item-card').content.firstElementChild.cloneNode(true);
    node.dataset.itemId = it.item_id;
    node.querySelector('.item-text').textContent = it.text;
    var criteriaEl = node.querySelector('.item-criteria');
    if (it.criteria) criteriaEl.querySelector('.criteria-body').textContent = it.criteria;
    else criteriaEl.remove();

    var segButtons = node.querySelectorAll('.seg-btn');
    var noteWrap = node.querySelector('.note-wrap');
    var textarea = node.querySelector('.note-input');
    var counter = node.querySelector('.note-counter');

    function paint() {
      var cur = state.draft.results[it.item_id];
      segButtons.forEach(function (btn) {
        var on = !!(cur && cur.r === btn.dataset.r);
        /* 시각 상태는 aria-pressed 하나로만 구동(CSS [aria-pressed="true"] 선택자) — 별도 class와 이원화하지 않는다 */
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      var isN = !!(cur && cur.r === 'N');
      noteWrap.hidden = !isN;
      node.classList.toggle('is-answered', !!cur);
      node.classList.toggle('is-invalid', isN && !(cur.n && cur.n.trim()));
    }
    segButtons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var r = btn.dataset.r;
        var prev = state.draft.results[it.item_id];
        var prevNote = (prev && prev.n) || '';
        state.draft.results[it.item_id] = (r === 'N') ? { r: r, n: prevNote } : { r: r };
        invalidateAck();
        paint();
        if (r === 'N') {
          textarea.value = prevNote;
          counter.textContent = prevNote.length + '/300';
          textarea.focus();
        }
        persistDraft();
        updateCategoryChip(node.closest('details'));
        updateProgressBar();
      });
    });
    textarea.addEventListener('input', function () {
      var v = textarea.value.slice(0, 300);
      if (v !== textarea.value) textarea.value = v;
      state.draft.results[it.item_id] = { r: 'N', n: v };
      invalidateAck();
      counter.textContent = v.length + '/300';
      node.classList.toggle('is-invalid', !v.trim());
      persistDraft();
    });

    var existing = state.draft.results[it.item_id];
    if (existing && existing.r === 'N') {
      textarea.value = existing.n || '';
      counter.textContent = (existing.n || '').length + '/300';
    }
    paint();
    return node;
  }
  function updateCategoryChip(detailsEl) {
    if (!detailsEl) return;
    var cards = detailsEl.querySelectorAll('.item-card');
    var total = cards.length, answered = 0;
    cards.forEach(function (c) { if (c.classList.contains('is-answered')) answered++; });
    var chip = detailsEl.querySelector('.cat-chip');
    if (chip) chip.textContent = answered + '/' + total;
  }
  function updateProgressBar() {
    var items = getCurrentTemplateItems();
    var pr = SafetyLogic.progress(state.draft, items);
    $('progress-text').textContent = pr.answered + '/' + pr.total;
    var pct = pr.total ? Math.round((pr.answered / pr.total) * 100) : 0;
    $('progress-fill').style.width = pct + '%';
    $('btn-jump-unanswered').disabled = pr.answered >= pr.total;
  }
  function jumpToUnanswered() {
    var items = getCurrentTemplateItems()
      .filter(function (it) { return it.type === 'group' || it.type === 'item'; })
      .sort(function (a, b) { return a.seq - b.seq; });
    var target = items.filter(function (it) { return !state.draft.results[it.item_id]; })[0];
    if (!target) return;
    var card = document.querySelector('.item-card[data-item-id="' + target.item_id + '"]');
    if (!card) return;
    var details = card.closest('details');
    if (details && !details.open) details.open = true;
    card.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
    var firstBtn = card.querySelector('.seg-btn');
    if (firstBtn) firstBtn.focus();
  }
  function onStep2Review() {
    var items = getCurrentTemplateItems();
    var pr = SafetyLogic.progress(state.draft, items);
    if (pr.answered < pr.total) {
      showBanner('error', '미응답 항목이 ' + (pr.total - pr.answered) + '개 있습니다.');
      jumpToUnanswered();
      return;
    }
    clearBanner();
    show('review');
  }

  /* ================= 검토 ================= */
  function renderReview() {
    if (!state.draft) { show('home'); return; }
    var draft = state.draft;
    var items = getCurrentTemplateItems();
    var byId = {};
    items.forEach(function (it) { byId[it.item_id] = it; });

    $('review-date').textContent = draft.inspect_date;
    $('review-company').textContent = companyName(draft.company_id);
    $('review-project').textContent = draft.project_name || projectName(draft.project_key);
    $('review-inspector').textContent = inspectorDisplay(draft.inspector_id);
    $('review-auditee-name').textContent = draft.auditee || '';

    var findings = Object.keys(draft.results)
      .map(function (id) { return { id: id, entry: draft.results[id] }; })
      .filter(function (x) { return x.entry && x.entry.r === 'N'; })
      .sort(function (a, b) { return ((byId[a.id] && byId[a.id].seq) || 0) - ((byId[b.id] && byId[b.id].seq) || 0); });

    var list = $('review-findings');
    list.innerHTML = '';
    if (!findings.length) {
      var ok = document.createElement('p');
      ok.className = 'findings-empty';
      ok.textContent = '부적합 항목이 없습니다.';
      list.appendChild(ok);
    } else {
      findings.forEach(function (f) {
        var node = $('tpl-finding-card').content.firstElementChild.cloneNode(true);
        var it = byId[f.id] || { text: f.id, category: '' };
        node.querySelector('.finding-category').textContent = it.category || '';
        node.querySelector('.finding-text').textContent = it.text;
        node.querySelector('.finding-note').textContent = f.entry.n || '';
        list.appendChild(node);
      });
    }

    var chk = $('chk-ack');
    chk.checked = !!draft.auditee_ack;
    var submitBtn = $('btn-submit');
    submitBtn.disabled = !chk.checked;
    submitBtn.textContent = '제출';
    $('btn-review-back').disabled = false;
  }
  function onAckChange(e) {
    state.draft.auditee_ack = !!e.target.checked;
    state.draft.auditee_ack_at = e.target.checked ? new Date().toISOString() : '';
    persistDraft();
    $('btn-submit').disabled = !e.target.checked;
  }
  function onSubmit() {
    if (state.submitting || !state.draft) return;
    var draft = state.draft;
    var payload = SafetyLogic.draftToPayload(draft, CONFIG, (state.masters && state.masters.rev) || 0);
    var mastersForValidate = withInjectedPin(state.masters || { inspectors: [] }, draft.inspector_id, draft.pin);
    var v = SafetyLib.validateSubmission(payload, mastersForValidate, todayStr());
    if (!v.ok) {
      showBanner('error', v.errors.map(function (e) { return e.msg + '(' + e.code + ')'; }).join(' / '));
      return;
    }
    state.submitting = true;
    var btn = $('btn-submit');
    btn.disabled = true;
    btn.textContent = '제출 중...';
    $('btn-review-back').disabled = true;
    submitToServer(payload).then(function (result) {
      state.submitting = false;
      if (result.ok) {
        state.storage.clearDraft();
        state.draft = null;
        showBanner('success', (result.data && result.data.dup) ? '이미 처리된 제출입니다(중복 확인됨).' : '제출 완료.');
        show('home');
        return;
      }
      var err = normalizeError(result.error);
      if (isPermanentError(err.code)) {
        /* 영구 오류(AUTH·VALIDATION): 같은 payload 는 몇 번을 보내도 거절된다.
           큐에 넣으면 무한 재시도가 되고, clearDraft 하면 유일한 작성본이 사라진다.
           → draft 를 그대로 둔 채 검토 화면에 머물러 사용자가 PIN·날짜 등을 고쳐 재제출하게 한다.
           (클라 사전검증은 withInjectedPin 때문에 PIN 오타를 구조적으로 못 잡는다 — 여기가 유일한 방어선) */
        renderReview();
        showBanner('error', '서버가 제출을 거절했습니다 — 자동 재시도하지 않습니다. 내용을 고쳐 다시 제출하세요: '
          + err.message + ' (' + err.code + ')');
        window.scrollTo(0, 0); /* 배너는 화면 최상단이다 — 스크롤된 상태면 거절 사실을 못 본다 */
        return;
      }
      /* 일시 오류·네트워크·비JSON: 지금까지대로 큐 적재 후 홈으로 */
      state.queue = SafetyLogic.queueReducer(state.queue, { type: 'ENQUEUE', item: payload });
      markQueueFailure(payload.submission_id, err);
      state.storage.saveQueue(state.queue);
      state.storage.clearDraft();
      state.draft = null;
      showBanner('error', '전송 실패 — 큐에 보관됨: ' + err.message + ' (' + err.code + ')');
      show('home');
    });
  }

  /* ================= 기동 ================= */
  function loadCachedMasters() {
    try {
      var raw = window.localStorage.getItem('sc_masters');
      if (!raw) return;
      var cached = JSON.parse(raw);
      if (cached && cached.data) { state.masters = cached.data; state.mastersSyncedAt = cached.syncedAt || null; }
    } catch (e) { /* 캐시 파싱 실패 = 캐시 없음 취급 */ }
  }
  function refreshMasters() {
    return loadMastersFromNetwork().then(function (result) {
      if (result.ok) {
        state.masters = result.data;
        state.mastersSyncedAt = new Date().toISOString();
        try {
          window.localStorage.setItem('sc_masters', JSON.stringify({ data: state.masters, syncedAt: state.mastersSyncedAt }));
        } catch (e) { /* 저장 공간 부족 등 — 캐시 없이 계속 진행 */ }
        state.masterBanner = CONFIG.MOCK ? { level: 'info', text: 'MOCK 모드 — 내장 목 데이터 사용 중(서버 미연결)' } : null;
      } else {
        state.masterBanner = state.masters
          ? { level: 'warn', text: '마스터 동기화 실패 — 마지막 저장본 사용 (' + result.error.code + ')' }
          : { level: 'error', text: '마스터를 불러오지 못했습니다. 네트워크를 확인하세요 (' + result.error.code + ')' };
      }
      if (state.currentScreen === 'home') renderHome();
    });
  }

  function wireEvents() {
    $('btn-back').addEventListener('click', onBack);
    $('btn-continue-draft').addEventListener('click', continueDraft);
    $('btn-sync-now').addEventListener('click', flushQueue);

    $('btn-step1-next').addEventListener('click', onStep1Next);
    $('f-company').addEventListener('change', onCompanyChange);
    $('f-project').addEventListener('change', onProjectChange);
    $('f-project-tmp').addEventListener('input', onProjectTmpInput);
    $('f-team').addEventListener('change', onTeamChange);
    $('f-inspector').addEventListener('change', onInspectorChange);
    $('f-pin').addEventListener('input', onPinInput);
    $('f-date').addEventListener('change', onDateChange);
    $('f-auditee').addEventListener('input', onAuditeeInput);

    $('btn-step2-back').addEventListener('click', function () { state.writeStep = 1; show('write'); });
    $('btn-step2-review').addEventListener('click', onStep2Review);
    $('btn-jump-unanswered').addEventListener('click', jumpToUnanswered);

    $('btn-review-back').addEventListener('click', function () {
      if (state.submitting) return;
      state.writeStep = 2; show('write');
    });
    $('chk-ack').addEventListener('change', onAckChange);
    $('btn-submit').addEventListener('click', onSubmit);
  }

  function init() {
    state.storage = SafetyLogic.storage(window);
    state.queue = state.storage.loadQueue();
    state.draft = state.storage.loadDraft();
    loadCachedMasters();
    wireEvents();
    show('home');
    refreshMasters();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
