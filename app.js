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
  /* MOCK 계획 목록(사전등록 데모용) — todayStr() 기준 상대일로 지연 생성해 지난/오늘/다가옴
     3그룹을 언제 열어도 재현한다. MOCK 의 plan_create/plan_cancel 이 이 배열을 직접 갱신한다. */
  var MOCK_PLANS = null;
  function ensureMockPlans() {
    if (MOCK_PLANS) return MOCK_PLANS;
    MOCK_PLANS = [
      { plan_id: 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001', planned_date: shiftDateStr(-5),
        company_id: 'MC1', company_name: '(주)한빛건설', project_key: 'MP1', project_name: '본관 3층 배관교체 공사',
        template_id: 'MOCK', template_ver: 1 },
      { plan_id: 'aaaaaaaa-bbbb-4ccc-8ddd-000000000002', planned_date: shiftDateStr(0),
        company_id: 'MC2', company_name: '대성설비', project_key: 'MP2', project_name: '옥외 변전실 증설 공사',
        template_id: 'MOCK', template_ver: 1 },
      { plan_id: 'aaaaaaaa-bbbb-4ccc-8ddd-000000000003', planned_date: shiftDateStr(5),
        company_id: 'MC1', company_name: '(주)한빛건설', project_key: 'MP1', project_name: '본관 3층 배관교체 공사',
        template_id: 'MOCK', template_ver: 1 }
    ];
    return MOCK_PLANS;
  }

  /* ---------- state ---------- */
  var state = {
    storage: null,
    masters: null,
    mastersSyncedAt: null,
    masterBanner: null,
    /* drafts: 계획별 임시저장 맵({ <plan_id|'adhoc'>: draft }) — sc_drafts 를 그대로 메모리에 올려 둔다.
       draft/draftKey: 현재 작성 화면이 붙잡고 있는 1건. draft 는 drafts[draftKey] 와 같은 객체
       참조라 입력이 바뀌면 drafts 도 자동으로 따라온다(별도 동기화 불필요, persistDraft 만 저장한다). */
    drafts: {},
    draft: null,
    draftKey: null,
    plans: [],
    plansSyncedAt: null,
    plansBanner: null,
    /* T1: 이 기기에서 이미 제출 시도(성공 또는 큐 적재)로 소비된 plan_id 표식(tombstone).
       큐 항목과 독립적으로 sc_plans 캐시에 함께 영속된다(persistPlansCache) — 큐 항목을
       지워도 남아야 응답 유실 → 큐 삭제 → 재작성 경로의 이중 기록을 막는다. */
    consumedPlanIds: {},
    /* 사전등록 화면 진입 시 1회 생성해 재시도에도 같은 값을 쓰는 plan_id(서버 멱등의 전제) */
    planFormId: null,
    creatingPlan: false,
    cancelingPlan: null,
    cancelingPlanBusy: false,
    queue: [],
    currentScreen: 'home',
    writeStep: 1,
    syncing: false,
    submitting: false,
    banner: null,
    /* 큐 행 '상세' 열림 상태(submission_id → true) — 재렌더가 열어 둔 패널을 닫지 않게 보존한다 */
    openQueueDetails: {},
    /* 같은 저장 실패를 타이핑마다 다시 고지하지 않기 위한 중복 억제 키 */
    lastSaveFailureKey: null
  };

  /* ---------- 유틸 ---------- */
  /* 시각 기준은 Asia/Seoul(+09:00) 고정이다(계약 K1).
     기기 시간대에 의존하면, 시간대가 어긋난 휴대폰에서 점검일 기본값·max 와 서버(KST) 판정이
     하루 어긋나 DATE_FUTURE·DATE_TOO_OLD 로 거절된다. */
  var KST_OFFSET_MIN = 9 * 60;
  /* 인자 시각을 KST 로 읽기 위한 대체 Date — 반드시 **UTC 게터**(getUTCFullYear 등)로 읽는다.
     로컬 게터(getFullYear)를 쓰면 안 된다: getTimezoneOffset() 은 '원래 시각'의 오프셋인데
     로컬 게터는 '시프트된 시각'의 오프셋을 적용해, 서머타임 경계에서 날짜가 하루 밀린다
     (Santiago·Chatham 등에서 실측). UTC 게터는 기기 시간대와 완전히 무관하다. */
  function toKst(date) {
    return new Date(date.getTime() + KST_OFFSET_MIN * 60000);
  }
  function todayStr() {
    var d = toKst(new Date());
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }
  /* todayStr() 을 days 만큼 이동한 KST 날짜 문자열 — MOCK 계획 목록을 "오늘" 기준 상대값으로
     시딩해 데모가 언제 열어도(지난/오늘/다가옴 3그룹이 항상 보이게) 의미 있게 유지되도록 한다. */
  function shiftDateStr(days) {
    var d = new Date(toKst(new Date()).getTime() + days * 86400000);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }
  function formatDateTime(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return iso;
    var k = toKst(d);
    return k.getUTCFullYear() + '-' + pad2(k.getUTCMonth() + 1) + '-' + pad2(k.getUTCDate()) + ' ' + pad2(k.getUTCHours()) + ':' + pad2(k.getUTCMinutes());
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
  /* W1: template_id 뿐 아니라 ver 까지 함께 대조한다 — getCurrentTemplateItems·startFromPlan·
     renderPlanList 세 곳이 공유한다(한 곳만 고치면 나머지가 옛 기준(id 만)으로 남아 같은
     결함이 다른 자리에서 재발한다). 못 찾으면 null. */
  function findCurrentTemplate(templateId, ver) {
    return ((state.masters && state.masters.templates) || []).filter(function (t) {
      return t.template_id === templateId && t.ver === ver;
    })[0] || null;
  }
  function getCurrentTemplateItems() {
    if (!state.masters || !state.draft) return [];
    var d = state.draft;
    /* W1: 정상 경로는 (id, ver) 정확 일치로 찾는다 — lib.js validateSubmission 의 ITEMS_MISMATCH
       판정과 같은 기준이어야, 화면에 그려지는 항목과 실제 제출 판본이 어긋나지 않는다.
       template_ver 가 없는 draft(옛 마이그레이션 경로, adhoc 이라도 newDraft 는 항상 ver 를
       채우므로 이 경우는 그 옛 경로뿐)는 예전처럼 id 만으로 찾는다 — 지시("막지 마라")대로
       여기서 막지 않는다. */
    var tpl = (d.template_ver == null)
      ? (state.masters.templates || []).filter(function (t) { return t.template_id === d.template_id; })[0]
      : findCurrentTemplate(d.template_id, d.template_ver);
    return tpl ? tpl.items : [];
  }
  /* companies/inspectors 와 동일한 방어적 대칭(§renderHome 주석 참고) — MOCK 경로는 서버를
     거치지 않으므로 클라에서도 active 필터링한다. 홈 템플릿 목록·사전등록 양식 선택 공용. */
  function activeTemplates() {
    return ((state.masters && state.masters.templates) || []).filter(function (t) { return t.active !== false; });
  }
  /* PIN 입력칸 공통 규격(숫자만·4자리) — f-pin/p-pin/pc-pin 3곳이 공유한다. */
  function clampPinInput(e) {
    var digits = e.target.value.replace(/\D/g, '').slice(0, 4);
    e.target.value = digits;
    return digits;
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
  /* 오류 코드 3분류(계약 K2):
       VALIDATION — 제출 내용 자체의 결함. 같은 payload 는 몇 번을 보내도 거절된다 → 자동 재시도 금지
       CONFIG·AUTH — 서버·시트 설정 / 키 불일치. 관리자가 고치거나 키가 갱신되면 그대로 풀린다 → 큐 보관 + 자동 재시도
       NETWORK·LOCK_TIMEOUT·SERVER·MOCK(그 외 전부) — 일시 오류 → 자동 재시도
     AUTH 를 영구로 두면 키 회전 사이에 쌓인 제출이 그대로 고착되므로 재시도 가능으로 분류한다. */
  var PERMANENT_ERROR_CODES = ['VALIDATION'];
  var ADMIN_ERROR_CODES = ['CONFIG', 'AUTH'];
  function isPermanentError(code) {
    return PERMANENT_ERROR_CODES.indexOf(String(code || '').toUpperCase()) !== -1;
  }
  /* 관리자 조치로 풀리는 오류 — 사용자가 고칠 것이 없으니 "고치세요"라고 하면 안 된다 */
  function isAdminError(code) {
    return ADMIN_ERROR_CODES.indexOf(String(code || '').toUpperCase()) !== -1;
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
    var item = null;
    state.queue = state.queue.map(function (q) {
      if (q.submission_id !== id) return q;
      var updated = {};
      Object.keys(q).forEach(function (k) { updated[k] = q[k]; });
      updated.reason_message = error.message || '';
      item = updated;
      return updated;
    });
    /* T1 반대 방향: 큐에 처음 들어갈 때는 절대 VALIDATION 일 수 없다(onSubmit 이 그 앞에서 먼저
       걸러 별도 처리한다) — 이 분기가 실제로 발화하는 경우는 재시도(flushQueue/'다시 시도')에서
       뒤늦게 payload 자체가 무효로 밝혀졌을 때뿐이다. 그때는 최초 큐 적재 때 세운 tombstone 을
       풀어야 현장이 다시 점검할 수 있다(계획을 영원히 막아두면 안 된다). */
    if (item && item.plan_id && isPermanentError(error.code)) {
      unmarkPlanConsumed(item.plan_id);
      /* U2: tombstone 을 푸는 것만으로는 안 끝난다 — 이 죽은 큐 항목을 '다시 시도' 가능한 채로
         남겨두면(629행 retryBtn 은 state==='failed' 면 이유를 안 가리고 보인다), '계획을 다시
         열어 제출'(tombstone 해제로 열린 정상 경로, 새 submission_id)과 '이 죽은 항목을
         나중에 다시 시도'(예: PIN 회전으로 그때는 통과) 가 서로 독립적인 두 제출 경로로
         동시에 살아있게 된다 — 서버는 각각 처음 보는 submission_id 라 계획 링크 가드(대장
         append 뒤에만 걸린다)로도 못 막고 대장에 2행이 남는다. 되살릴 대상은 하나여야
         한다(K3) — tombstone 해제가 이미 "계획을 다시 연다"는 그 하나이므로, 이 큐 항목은
         재전송 불가로 확정(retire)한다: 조용히 없애면 안 되므로(K4) 배너로 알린다. */
      state.queue = state.queue.filter(function (q) { return q.submission_id !== id; });
      showBanner('error', '이전 제출이 입력 오류로 거절되어 미전송 목록에서 정리했습니다 — '
        + '계획을 다시 열어 확인 후 제출하세요: ' + (error.message || '') + ' (' + error.code + ')');
      window.scrollTo(0, 0);
    }
  }
  /* ---------- 저장 실패 고지 (계약 K4: 조용한 실패 금지) ----------
     logic.js 의 save 계열은 던지지 않고 false 를 돌려준다. 그 false 를 버리면
     "저장됨"이 거짓말이 되고 기록이 소리 없이 사라진다 — 여기서 전부 소비한다. */
  function saveErrorSuffix() {
    var e = state.storage && state.storage.lastError;
    return e ? (' (' + e.op + ': ' + e.message + ')') : '';
  }
  function notifySaveFailure(what, dedupeKey) {
    /* 임시저장은 타이핑마다 호출된다 — 같은 실패를 매 입력마다 다시 띄우면 배너를 닫을 수 없다 */
    if (dedupeKey && state.lastSaveFailureKey === dedupeKey) return;
    state.lastSaveFailureKey = dedupeKey || null;
    showBanner('error', what + ' 저장에 실패했습니다 — 새로고침하거나 탭을 닫으면 이 기록이 사라집니다.' + saveErrorSuffix());
  }
  function persistDraft() {
    if (!state.draft || !state.draftKey) return true;
    var ok = state.storage.saveDraft(state.draftKey, state.draft);
    if (ok) state.lastSaveFailureKey = null;
    else notifySaveFailure('작성 중인 점검', 'draft');
    return ok;
  }
  /* 제출 성공(또는 큐 적재 후 홈 복귀) 경로 공용 — 현재 붙잡고 있는 draft 를 drafts 맵과
     storage 양쪽에서 지운다(계획별 임시저장, 설계 §6-4).
     반환값(H8, 계약 K4): storage.clearDraft 는 던지지 않고 실패를 false 로 보고하도록 설계돼
     있는데(logic.js), 이 값을 버리면 저장소가 막힌 기기에서 "제출 완료"만 뜨고 옛 sc_drafts 가
     재적재 시 되살아나 이미 제출된 점검이 임시저장으로 부활한다. 호출자가 반환값을 소비해
     배너로 알린다(여기서 직접 showBanner 하지 않는다 — 호출자가 성공 문구를 덮어써야 한다). */
  function clearActiveDraft() {
    if (!state.draftKey) return true;
    var ok = state.storage.clearDraft(state.draftKey);
    if (state.drafts) delete state.drafts[state.draftKey];
    state.draft = null;
    state.draftKey = null;
    return ok;
  }
  function persistQueue() {
    var ok = state.storage.saveQueue(state.queue);
    if (ok) state.lastSaveFailureKey = null;
    else notifySaveFailure('미전송 목록', 'queue');
    return ok;
  }
  function invalidateAck() {
    /* 제출 내용(1단계 기본정보 + 2단계 응답) 중 무엇이든 검토 확인 이후 바뀌면 이전 확인은 무효 —
       재확인을 강제해 "확인 시점 ≠ 실제 제출 내용" 무결성 갭을 막는다.
       특히 수검자·점검자가 바뀌면 "누가 무엇을 확인했는가" 자체가 달라진다. */
    if (!state.draft) return;
    state.draft.auditee_ack = false;
    state.draft.auditee_ack_at = '';
  }

  /* ---------- 네트워크 (fetch 규약 verbatim, 설계 §5.2) ----------
     응답이 오지 않는 요청은 반드시 끊는다. 끊지 않으면 submitting/syncing 플래그가 true 로
     고착돼 제출 버튼과 큐가 함께 얼어붙는다(사용자가 앱을 다시 띄우는 것 말고 할 게 없어진다).
     타임아웃은 재시도 가능(NETWORK)으로 취급한다. */
  var REQUEST_TIMEOUT_MS = 25000;
  var TIMEOUT_MESSAGE = '서버 응답이 없어 ' + Math.round(REQUEST_TIMEOUT_MS / 1000) + '초 만에 요청을 중단했습니다';
  /* 항상 { ok, ... } 봉투로 resolve 한다 — 절대 reject 하지 않는다.
     AbortController 가 없는 구형 브라우저에서도 타이머가 봉투를 확정하므로 프로미스가 매달리지 않는다. */
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
  function loadMastersFromNetwork() {
    return CONFIG.MOCK ? mockMasters() : fetchMastersRemote();
  }
  function fetchMastersRemote() {
    return requestJson(CONFIG.API_URL + '?action=masters&k=' + CONFIG.SHARED_KEY, null);
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
    return requestJson(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'submit', k: CONFIG.SHARED_KEY, payload: payload }),
      redirect: 'follow'
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
  function loadPlansFromNetwork() {
    return CONFIG.MOCK ? mockPlansList() : fetchPlansRemote();
  }
  function fetchPlansRemote() {
    return requestJson(CONFIG.API_URL + '?action=plans&k=' + CONFIG.SHARED_KEY, null);
  }
  function mockPlansList() {
    return new Promise(function (resolve) {
      setTimeout(function () { resolve({ ok: true, data: { plans: ensureMockPlans().slice() } }); }, 150);
    });
  }
  function createPlanOnServer(payload) {
    return CONFIG.MOCK ? mockPlanCreate(payload) : realPlanCreate(payload);
  }
  function realPlanCreate(payload) {
    return requestJson(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'plan_create', k: CONFIG.SHARED_KEY, payload: payload }),
      redirect: 'follow'
    });
  }
  /* MOCK plan_create: 실제 gas/main.gs handlePlanCreate_ 의 신규 공사 재사용 규칙(회사별
     정규화 비교)만 흉내 낸다 — 데모 목적, PIN 은 검증하지 않는다(서버가 검증할 자리가 없다). */
  function mockPlanCreate(payload) {
    // eslint-disable-next-line no-console
    console.log('[MOCK plan_create]', payload);
    return new Promise(function (resolve) {
      setTimeout(function () {
        var comp = ((state.masters && state.masters.companies) || []).filter(function (c) { return c.company_id === payload.company_id; })[0];
        var reused = false, created = null, projectKey = payload.project_key, projectName = '';
        if (projectKey) {
          var proj = ((state.masters && state.masters.projects) || []).filter(function (p) { return p.project_id === projectKey; })[0];
          projectName = proj ? proj.name : '';
        } else {
          var norm = function (s) { return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase(); };
          var want = norm(payload.new_project_name);
          var existing = ((state.masters && state.masters.projects) || []).filter(function (p) {
            return p.company_id === payload.company_id && norm(p.name) === want;
          })[0];
          if (existing) {
            projectKey = existing.project_id; projectName = existing.name; reused = true;
          } else {
            projectKey = 'MOCK-P' + Math.floor(100 + Math.random() * 900);
            projectName = payload.new_project_name;
            created = { project_id: projectKey, name: projectName };
          }
        }
        var plan = {
          plan_id: payload.plan_id, planned_date: payload.planned_date,
          company_id: payload.company_id, company_name: comp ? comp.name : '',
          project_key: projectKey, project_name: projectName,
          template_id: payload.template_id, template_ver: payload.template_ver
        };
        ensureMockPlans().push(plan);
        resolve({ ok: true, data: { dup: false, reused_project: reused, created_project: created, plan: plan } });
      }, 300);
    });
  }
  function cancelPlanOnServer(payload) {
    return CONFIG.MOCK ? mockPlanCancel(payload) : realPlanCancel(payload);
  }
  function realPlanCancel(payload) {
    return requestJson(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'plan_cancel', k: CONFIG.SHARED_KEY, payload: payload }),
      redirect: 'follow'
    });
  }
  function mockPlanCancel(payload) {
    // eslint-disable-next-line no-console
    console.log('[MOCK plan_cancel]', payload);
    return new Promise(function (resolve) {
      setTimeout(function () {
        MOCK_PLANS = ensureMockPlans().filter(function (p) { return p.plan_id !== payload.plan_id; });
        resolve({ ok: true, data: { canceled: true } });
      }, 200);
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
  /* 저장소를 못 쓰는 기기(iOS 사생활 보호 모드 등)에서는 "전송 대기 저장됨"이 거짓말이 된다.
     닫을 수 있는 알림 배너가 아니라, 상태가 풀릴 때까지 홈에 상시 떠 있는 경고로 고지한다(계약 K4). */
  function renderStorageBanner() {
    var el = $('home-storage-banner');
    if (state.storage && state.storage.available) { el.hidden = true; return; }
    var msg = '이 기기에서는 기록을 저장할 수 없습니다(사생활 보호 모드 등). '
      + '새로고침하거나 탭을 닫으면 작성 중인 점검과 미전송 목록이 사라집니다 — 점검을 마치면 바로 전송하세요.';
    /* role="alert" 이므로 텍스트를 다시 쓰면 스크린리더가 매 재렌더마다 다시 읽는다 — 바뀔 때만 쓴다 */
    if (el.textContent !== msg) el.textContent = msg;
    el.className = 'banner banner-error';
    el.hidden = false;
  }

  /* ---------- 화면 전환 ---------- */
  function show(name) {
    state.currentScreen = name;
    $('screen-home').hidden = name !== 'home';
    $('screen-write').hidden = name !== 'write';
    $('screen-review').hidden = name !== 'review';
    $('screen-plan').hidden = name !== 'plan';
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
    else if (name === 'plan') { title.textContent = '점검 사전등록'; back.hidden = false; }
  }
  function onBack() {
    if (state.submitting) return; /* 제출 진행 중 화면 이탈 금지 — 완료 전 draft가 다른 화면 편집으로 덮이는 경합 방지 */
    if (state.currentScreen === 'review') { state.writeStep = 2; show('write'); return; }
    if (state.currentScreen === 'write') {
      if (state.writeStep === 2) { state.writeStep = 1; show('write'); }
      else { show('home'); }
      return;
    }
    /* H9: 등록 요청이 떠 있는 동안(최대 25초) 이탈을 막는다 — 떠나도 요청은 계속 흐르지만,
       이탈을 막으면 애초에 "늦게 온 응답이 남의 화면을 홈으로 튕기는" 경합 창을 좁힌다.
       (onCreatePlan 의 sameContext 판정이 최종 방어선이고, 이건 보조다.) */
    if (state.currentScreen === 'plan' && state.creatingPlan) return;
    if (state.currentScreen === 'plan') { show('home'); }
  }

  /* ================= 홈 ================= */
  function renderHome() {
    $('home-sync-line').textContent = state.mastersSyncedAt
      ? ('마스터 동기화: ' + formatDateTime(state.mastersSyncedAt))
      : '마스터 동기화 안 됨';
    renderStorageBanner();
    renderMasterBanner();
    renderPlansSyncLine();
    renderPlansBanner();
    renderPlanList();

    var list = $('home-template-list');
    list.innerHTML = '';
    var templates = activeTemplates();
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

    /* '이어쓰기' 카드는 adhoc(계획 없이 시작한) 임시저장 전용이다(설계 §6-4) — 계획별 임시저장은
       각 계획 행의 '이어서 작성' 버튼으로 들어간다(renderPlanList). */
    var contWrap = $('home-continue-wrap');
    var adhocDraft = state.drafts && state.drafts.adhoc;
    if (adhocDraft) {
      contWrap.hidden = false;
      var tpl = (state.masters && state.masters.templates || []).filter(function (t) { return t.template_id === adhocDraft.template_id; })[0];
      $('home-continue-label').textContent = '작성 중: ' + (tpl ? tpl.name : adhocDraft.template_id) + ' (' + adhocDraft.inspect_date + ')';
    } else {
      contWrap.hidden = true;
    }

    var badge = $('home-queue-badge');
    var count = state.queue.length;
    badge.textContent = String(count);
    badge.hidden = count === 0;
    $('home-queue-empty').hidden = count !== 0;
    /* '지금 동기화'는 자동 전송 대상이 있을 때만 활성 — 영구 실패만 남은 큐에서 눌러도
       아무 일이 없으면 사용자는 앱이 고장 났다고 판단한다. */
    var autoTargets = autoRetryTargets().length;
    var syncBtn = $('btn-sync-now');
    syncBtn.disabled = state.syncing || autoTargets === 0;
    var hint = $('home-queue-hint');
    if (count > 0 && autoTargets === 0) {
      hint.hidden = false;
      hint.textContent = '자동 전송 대상이 없습니다. 항목별 \'다시 시도\'를 쓰세요.';
    } else {
      hint.hidden = true;
    }
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
        /* 3분류(계약 K2)를 문구로 구분한다 — "언젠간 전송되겠지"라는 오해도, 사용자가 고칠 수 없는
           설정 오류를 "고치세요"라고 미는 오해도 둘 다 끊는다. */
        if (isPermanentError(q.reason)) {
          stateEl.textContent = '전송 불가 — 제출 내용 결함으로 거절됨(자동 재시도 안 함): ' + detail;
        } else if (/PLAN_LINK_HEADER/.test(detail)) {
          /* H-S1: 서버는 점검계획 탭 헤더가 손상되면 점검대장·부적합대장 기록은 정상 저장한
             뒤(부분 성공) CONFIG/PLAN_LINK_HEADER 를 돌려준다(gas/main.gs). q.reason 은
             'CONFIG'(isAdminError 대상)뿐이고 실제 세부 코드는 markQueueFailure 가 채우는
             q.reason_message 에 실린다(직접 확인함) — 그래서 reason 이 아니라 이 두 필드를
             합친 detail 로 매칭한다. isAdminError 보다 먼저 걸어야 한다(안 그러면 "관리자 확인
             필요" 문구에 밀려 이 분기가 죽는다) — 큐 보관·자동 재전송 자체는 옳다(재전송이
             관리자 조치 후 계획 연동을 완성한다), 문구만 다르게 한다: 기록이 이미 저장됐다는
             사실을 모르면 사용자가 같은 점검을 다시 작성해 점검대장에 2행이 남는다(H1과 같은 뿌리). */
          stateEl.textContent = '점검 기록은 저장되었습니다. 계획 연동만 관리자 조치 대기 중입니다 — 다시 작성하지 마세요.';
        } else if (isAdminError(q.reason)) {
          stateEl.textContent = '관리자 확인이 필요합니다. 해결되면 자동으로 전송됩니다 (' + detail + ')';
        } else {
          stateEl.textContent = '재전송 대기 — 실패(' + detail + ')';
        }
        stateEl.classList.add('text-danger');
      } else {
        stateEl.textContent = '전송 대기 중';
        stateEl.classList.add('text-neutral');
      }

      /* 상세: 갇힌 항목의 내용을 읽을 수 있게 (textContent 로만 — innerHTML 금지).
         열림 상태는 state 에 남긴다 — 재렌더가 읽고 있던 패널을 닫아버리면 안 된다. */
      var detailBtn = node.querySelector('.queue-btn-detail');
      var payloadEl = node.querySelector('.queue-payload');
      payloadEl.textContent = queuePayloadPreview(q);
      paintDetailToggle(detailBtn, payloadEl, !!state.openQueueDetails[q.submission_id]);
      detailBtn.addEventListener('click', function () {
        var willShow = payloadEl.hidden;
        if (willShow) state.openQueueDetails[q.submission_id] = true;
        else delete state.openQueueDetails[q.submission_id];
        paintDetailToggle(detailBtn, payloadEl, willShow);
      });

      /* 다시 시도(계약 K3): 자동 재시도에서 제외된 항목도 사람이 직접 되살릴 수 있어야 한다.
         삭제가 유일한 탈출구가 되면, 관리자가 시트를 고친 뒤에도 현장 기록은 복구 불가로 굳는다.
         queueReducer(logic.js)는 이 전이를 모르므로 큐 배열을 여기서 직접 다룬다. */
      var retryBtn = node.querySelector('.queue-btn-retry');
      /* V2: VALIDATION(영구 오류, isPermanentError)로 거절된 항목은 '다시 시도'를 숨긴다 —
         같은 payload 는 몇 번을 다시 보내도 같은 결과이고(정의상 영구), U2 의 retire 로 지금은
         이런 항목이 큐에 남는 경로가 없지만 그건 markQueueFailure 쪽의 방어일 뿐이다 — 이
         버튼 자신의 조건도 별도로 막아야 나중에 다른 경로로 VALIDATION 항목이 큐에 남더라도
         재전송 가능한 채로 노출되지 않는다(같은 결함의 재발 방지, 심층 방어).
         K3(사람이 처리할 길)는 깬 게 아니다 — 바로 위 stateEl 이 이미 "전송 불가 — 제출 내용
         결함으로 거절됨(자동 재시도 안 함)"이라는 사유를 보여주고(602행), 삭제 버튼은 이 분기와
         무관하게 항상 남는다(사람이 처리할 길 = 사유 확인 + 삭제, 재전송만 막는다). */
      if (q.state !== 'failed' || isPermanentError(q.reason)) {
        retryBtn.hidden = true;
      } else {
        retryBtn.disabled = state.syncing;
        retryBtn.addEventListener('click', function () {
          state.queue = state.queue.map(function (x) {
            if (x.submission_id !== q.submission_id) return x;
            var revived = {};
            Object.keys(x).forEach(function (k) {
              if (k !== 'reason' && k !== 'reason_message') revived[k] = x[k];
            });
            revived.state = 'pending';
            return revived;
          });
          persistQueue();
          renderHome();
          flushQueue();
        });
      }

      /* 삭제: 되살릴 수 없는 항목의 마지막 정리 수단. 전송 중에는 경합을 피해 잠근다. */
      var deleteBtn = node.querySelector('.queue-btn-delete');
      deleteBtn.disabled = state.syncing;
      deleteBtn.addEventListener('click', function () {
        var ok = window.confirm('이 미전송 항목을 큐에서 삭제합니다. 삭제하면 복구할 수 없고 서버에도 전송되지 않습니다. 계속할까요?');
        if (!ok) return;
        state.queue = state.queue.filter(function (x) { return x.submission_id !== q.submission_id; });
        delete state.openQueueDetails[q.submission_id];
        persistQueue();
        renderHome();
      });

      wrap.appendChild(node);
    });
  }
  function paintDetailToggle(btn, payloadEl, open) {
    payloadEl.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.textContent = open ? '상세 닫기' : '상세';
  }

  /* ---------- 홈: 예정된 점검(사전등록 계획) ---------- */
  /* 정렬 그룹: 지난 미완(예정일 < 오늘) → 오늘 → 다가오는 것(설계 §6-1). 그룹 안에서는 예정일 오름차순 —
     planned_date 가 yyyy-MM-dd 라 문자열 비교가 곧 날짜 비교다. */
  function planGroup(p, today) {
    if (p.planned_date < today) return 0;
    if (p.planned_date === today) return 1;
    return 2;
  }
  function renderPlanList() {
    var wrap = $('home-plans-list');
    wrap.innerHTML = '';
    var today = todayStr();
    /* 이미 그 계획으로 작성해 큐에 넣은 제출이 있으면(전송 대기 중) '작성 시작'을 다시 누르게
       두면 안 된다 — 새 submission_id 로 또 작성하면 서버 멱등에 안 걸려 점검대장에 2행이
       남는다(H1). 계획은 서버에서 아직 planned 이므로 목록에는 남기되 시작을 막는다. */
    var queued = queuedPlanIdSet(state.queue);
    var plans = (state.plans || []).slice().sort(function (a, b) {
      var ga = planGroup(a, today), gb = planGroup(b, today);
      if (ga !== gb) return ga - gb;
      if (a.planned_date < b.planned_date) return -1;
      if (a.planned_date > b.planned_date) return 1;
      return 0;
    });
    $('home-plans-empty').hidden = plans.length !== 0;
    plans.forEach(function (p) {
      var node = $('tpl-plan-row').content.firstElementChild.cloneNode(true);
      var overdue = p.planned_date < today;
      var dateEl = node.querySelector('.plan-date');
      dateEl.textContent = p.planned_date + (overdue ? ' · 지남' : '');
      dateEl.classList.toggle('plan-overdue', overdue);
      node.querySelector('.plan-project').textContent = p.project_name;
      node.querySelector('.plan-company').textContent = p.company_name;

      var hasDraft = !!(state.drafts && state.drafts[p.plan_id]);
      var startBtn = node.querySelector('.plan-btn-start');
      var noteEl = node.querySelector('.plan-note');
      /* T1: 큐 삭제 후에도 "이미 제출했다"는 사실은 tombstone(consumedPlanIds)에 남아 있어야
         재작성(→ 새 submission_id → 점검대장 2행)을 막는다 — queued 만 보면 큐 삭제로 이
         방어가 풀린다. */
      var isConsumed = !!(state.consumedPlanIds && state.consumedPlanIds[p.plan_id]);
      /* W1: queued/isConsumed 와 같은 표시 방식을 재사용한다(판단 — 이미 검증된 패턴, 새 UI를
         안 만들어도 된다) — masters 미수신·p.template_ver 없음(옛 계획)은 판정하지 않는다
         (startFromPlan 의 진입 시점 검사와 같은 기준, 오판 방지). */
      var isVersionMismatch = !!(state.masters && p.template_ver != null && !findCurrentTemplate(p.template_id, p.template_ver));
      if (queued[p.plan_id]) {
        startBtn.textContent = '전송 대기 중';
        startBtn.disabled = true;
        noteEl.hidden = false;
        noteEl.textContent = '이미 작성해 미전송 목록에 있습니다 — 아래 미전송 목록에서 전송하세요.';
      } else if (isConsumed) {
        startBtn.textContent = '이미 전송됨';
        startBtn.disabled = true;
        noteEl.hidden = false;
        noteEl.textContent = '이미 작성해 전송했습니다 — 다시 작성하지 마세요. 다시 열어야 하면 관리자에게 문의하세요.';
      } else if (isVersionMismatch) {
        startBtn.textContent = '작성 불가';
        startBtn.disabled = true;
        noteEl.hidden = false;
        noteEl.textContent = "이 계획의 점검 양식이 개정되었습니다 — '새 점검 시작'으로 작성하거나 관리자에게 문의하세요.";
      } else {
        startBtn.textContent = hasDraft ? '이어서 작성' : '작성 시작';
        startBtn.disabled = false;
        noteEl.hidden = true;
        startBtn.addEventListener('click', function () { startFromPlan(p); });
      }

      node.querySelector('.plan-btn-cancel').addEventListener('click', function () { openPlanCancelPanel(p); });

      wrap.appendChild(node);
    });
  }
  function renderPlansSyncLine() {
    $('home-plans-sync-line').textContent = state.plansSyncedAt
      ? ('예정 점검 동기화: ' + formatDateTime(state.plansSyncedAt))
      : '예정 점검 동기화 안 됨';
  }
  function renderPlansBanner() {
    var el = $('home-plans-banner');
    if (!state.plansBanner) { el.hidden = true; return; }
    el.hidden = false;
    el.className = 'banner banner-' + state.plansBanner.level;
    el.textContent = state.plansBanner.text;
  }
  function openPlanCancelPanel(plan) {
    state.cancelingPlan = plan;
    /* H7: 이 계획으로 이미 작성 중인 임시저장이 있으면 취소와 함께 사라진다는 걸 미리 알린다 —
       계획별 임시저장의 유일한 진입점이 이 행의 '이어서 작성' 버튼이라, 계획이 목록에서
       빠지는 순간 도달할 방법이 없어진다(내 기기의 draft. 다른 기기·PIN 없는 draft 는 범위 밖). */
    var hasDraft = !!(state.drafts && state.drafts[plan.plan_id]);
    $('plan-cancel-target').textContent = plan.planned_date + ' · ' + plan.company_name + ' · ' + plan.project_name
      + ' 계획을 취소합니다. 등록자 인증 후 확정됩니다.'
      + (hasDraft ? ' 이 계획에 작성 중인 내용이 있으며 취소하면 함께 삭제됩니다.' : '');
    populateTeamSelect('pc-team');
    $('pc-team').value = '';
    populateInspectorSelect('', 'pc-inspector');
    $('pc-pin').value = '';
    $('plan-cancel-panel').hidden = false;
    $('plan-cancel-panel').scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
  }
  function closePlanCancelPanel() {
    state.cancelingPlan = null;
    $('plan-cancel-panel').hidden = true;
  }
  function onPlanCancelConfirm() {
    if (state.cancelingPlanBusy || !state.cancelingPlan) return;
    var plan = state.cancelingPlan;
    var inspectorId = $('pc-inspector').value;
    var pin = $('pc-pin').value;
    var missing = [], focusId = null;
    if (!inspectorId) { missing.push('등록자'); focusId = focusId || 'pc-inspector'; }
    if (!/^\d{4}$/.test(pin || '')) { missing.push('PIN(4자리)'); focusId = focusId || 'pc-pin'; }
    if (missing.length) {
      /* #banner-region 은 문서 최상단·비-sticky 다(H5) — 취소 패널은 scrollIntoView 로 화면
         가운데로 끌려와 있어, 배너만 띄우면 위쪽으로 스크롤된 실패 사실을 못 본다. */
      showBanner('error', '다음 항목을 확인하세요: ' + missing.join(', '));
      window.scrollTo(0, 0);
      if (focusId) { var fel = $(focusId); if (fel && !fel.disabled) fel.focus(); }
      return;
    }
    state.cancelingPlanBusy = true;
    var btn = $('btn-plan-cancel-confirm');
    btn.disabled = true;
    btn.textContent = '취소 처리 중...';
    cancelPlanOnServer({ plan_id: plan.plan_id, inspector_id: inspectorId, pin: pin }).then(function (result) {
      if (result.ok) {
        state.plans = state.plans.filter(function (p) { return p.plan_id !== plan.plan_id; });
        persistPlansCache();
        /* H7: 계획이 사라지면 그 계획의 임시저장(PIN 포함)이 도달 불가·삭제 불가로 남는다 —
           행이 없어지면 '이어서 작성' 진입점 자체가 사라지기 때문이다. 여기서 함께 정리한다.
           clearDraft 의 반환값을 본다(계약 K4) — 삭제 실패를 조용히 삼키지 않는다. */
        var hadDraft = !!(state.drafts && state.drafts[plan.plan_id]);
        var clearedOk = true;
        if (hadDraft) {
          clearedOk = state.storage.clearDraft(plan.plan_id);
          delete state.drafts[plan.plan_id];
          if (state.draftKey === plan.plan_id) { state.draft = null; state.draftKey = null; }
        }
        closePlanCancelPanel();
        showBanner(clearedOk ? 'success' : 'error',
          '점검 계획을 취소했습니다.' + (hadDraft ? (clearedOk ? ' 작성 중이던 내용도 삭제했습니다.'
            : ' 다만 이 기기의 임시저장 삭제에 실패했습니다 — 저장소를 확인하세요.' + saveErrorSuffix()) : ''));
        renderHome();
        return;
      }
      var err = normalizeError(result.error);
      /* Task 3 인계 문구(findings F4/F5) — 사용자가 고칠 수 있는 사유로 번역한다 */
      var friendly = /PLAN_ALREADY_DONE/.test(err.message) ? '이미 완료된 점검입니다. 목록을 새로고침하세요.'
        : /PLAN_NOT_FOUND/.test(err.message) ? '이미 처리되었거나 없는 계획입니다. 목록을 새로고침하세요.'
        : /PIN_MISMATCH/.test(err.message) ? 'PIN이 일치하지 않습니다.'
        : err.message;
      showBanner('error', '취소에 실패했습니다: ' + friendly + ' (' + err.code + ')');
      window.scrollTo(0, 0);
    }).finally(function () {
      state.cancelingPlanBusy = false;
      btn.disabled = false;
      btn.textContent = '취소 확정';
    }).catch(function (e) {
      showBanner('error', '취소 처리 중 오류가 발생했습니다: ' + ((e && e.message) || e));
      window.scrollTo(0, 0);
    });
  }
  /* T1: state.plans/plansSyncedAt/consumedPlanIds 셋을 한 번에 sc_plans 캐시로 영속한다.
     이 헬퍼 하나로 몰아야 하는 이유 — savePlans 호출부가 여러 곳(재조회·로컬 제거·upsert·계획
     취소)인데, consumed 필드를 하나라도 안 실어 보내면 그 저장이 앞선 소비 표식을 지운다
     (savePlans 는 sc_plans 전체를 덮어쓰는 API 라 부분 갱신이 없다). 새 저장 지점을 추가할 때도
     이 함수를 거치면 표식이 빠질 일이 없다.
     U1(6→7차): 반환값을 버리면 이 저장이 실패해도(예: 저장소 용량 초과) "표식이 섰다"는 거짓
     상태가 조용히 퍼진다(계약 K4) — boolean 을 돌려주고, 이 값을 실제로 쓰는 호출자(markPlanConsumed
     → onSubmit)는 그 값에 따라 완료 처리를 늦춘다. 저장 성공/실패를 배너로도 드러낸다(persistDraft/
     persistQueue 와 같은 notifySaveFailure 관용구, 234행). */
  function persistPlansCache() {
    var ok = state.storage.savePlans({ data: state.plans, syncedAt: state.plansSyncedAt, consumed: state.consumedPlanIds });
    if (ok) state.lastSaveFailureKey = null;
    else notifySaveFailure('예정 점검 목록', 'plans');
    return ok;
  }
  /* T1: 이 기기에서 그 계획으로 제출을 서버에 내보냈다(성공이든 큐 적재든) — tombstone 을 큐와
     독립적으로 남긴다. 큐 항목을 사용자가 지워도 이 표식은 남아 재작성(→ 새 submission_id →
     서버 멱등 불성립 → 점검대장 2행)을 막는다.
     U1: 메모리 표식(state.consumedPlanIds)은 영속 성공 여부와 무관하게 항상 세운다 — 이번
     세션 안에서는 렌더가 메모리를 보므로 즉시 방어가 걸린다. 영속 결과(bool)는 그대로
     돌려줘 호출자(onSubmit)가 "이 기기 재시작에도 방어가 살아남는지"를 판단하게 한다.
     planId 가 없으면(세울 것이 없으면) 실패도 없다 — true 를 돌려줘 호출자가 오판하지 않게 한다. */
  function markPlanConsumed(planId) {
    if (!planId) return true;
    state.consumedPlanIds[planId] = true;
    return persistPlansCache();
  }
  /* T1 반대 방향: 제출이 영구 오류(VALIDATION)로 거절되면 그 payload 자체가 못 쓴다는 뜻이라
     계획을 계속 막아두면 현장이 재점검을 할 방법이 없어진다(설계 K3 와 충돌) — 반드시 푼다.
     U1: 위와 대칭으로 boolean 을 돌려준다(지울 게 없으면 true — 실패할 일이 없다). */
  function unmarkPlanConsumed(planId) {
    if (!planId || !state.consumedPlanIds[planId]) return true;
    delete state.consumedPlanIds[planId];
    return persistPlansCache();
  }
  /* T1: 표식이 영원히 쌓이지 않게 한다 — 서버가 그 계획을 더 이상 'planned' 로 돌려주지 않으면
     (done 이든 canceled 든) 로컬 표식도 정리한다. 서버 재조회(refreshPlans) 직후에만 호출한다 —
     캐시가 아니라 서버 응답을 근거로 지워야, 오프라인 중 캐시가 오래됐다는 이유로 표식을
     섣불리 지워 그 사이 재작성을 허용해버리는 사고를 막는다. */
  function pruneConsumedPlanIds(currentPlans) {
    var present = {};
    (currentPlans || []).forEach(function (p) { if (p && p.plan_id) present[p.plan_id] = true; });
    var changed = false;
    Object.keys(state.consumedPlanIds).forEach(function (id) {
      if (!present[id]) { delete state.consumedPlanIds[id]; changed = true; }
    });
    return changed;
  }
  /* 제출이 서버에 접수되면 그 계획은 더 이상 '작성 시작' 대상이 아니다(서버는 done 으로 전이한다).
     재조회를 기다리지 않고 로컬 진실을 먼저 맞춘다 — 오프라인에서도 목록이 거짓말하지 않게(H1). */
  function removePlanLocally(planId) {
    if (!planId) return false;
    var before = (state.plans || []).length;
    state.plans = (state.plans || []).filter(function (p) { return p.plan_id !== planId; });
    if (state.plans.length === before) return false;
    persistPlansCache();
    return true;
  }
  /* 큐에 걸린 계획 id 집합 — 큐는 영속되므로 재적재 후에도 같은 판정이 나온다(파생 상태, 별도 저장 금지) */
  function queuedPlanIdSet(queue) {
    var set = Object.create(null);
    (queue || []).forEach(function (q) { if (q && q.plan_id) set[q.plan_id] = 1; });
    return set;
  }
  /* 서버가 이번 등록에서 채번한 공사를 마스터에 즉시 흡수한다(설계 §4-2·§5, H4). 흡수하지 않으면
     같은 세션에서 그 계획을 시작했을 때 lib.js 의 PROJECT_UNKNOWN 으로 제출이 막히고,
     공사 select 가 잠겨 있어(renderWriteStep1) 사용자가 고칠 방법이 없다. */
  function upsertProject(proj) {
    if (!state.masters) return;               /* 마스터 미수신 세션 — 재적재로 복구된다 */
    var list = state.masters.projects = state.masters.projects || [];
    var i = -1;
    list.forEach(function (p, k) { if (p.project_id === proj.project_id) i = k; });
    if (i >= 0) list[i] = proj; else list.push(proj);
    state.storage.saveMasters({ data: state.masters, syncedAt: state.mastersSyncedAt });
  }
  /* 서버가 돌려준 plan 을 목록에 즉시 반영한다(H4) — refreshPlans 재조회가 끊기거나 실패해도
     방금 등록한 계획이 화면에 남는다(재조회는 보조 정합 확인일 뿐 유일한 반영 경로가 아니다). */
  function upsertPlan(plan) {
    if (!plan || !plan.plan_id) return;
    state.plans = (state.plans || []).filter(function (p) { return p.plan_id !== plan.plan_id; });
    state.plans.push(plan);
    persistPlansCache();
  }
  function refreshPlans() {
    return loadPlansFromNetwork().then(function (result) {
      if (result.ok) {
        state.plans = (result.data && result.data.plans) || [];
        state.plansSyncedAt = new Date().toISOString();
        pruneConsumedPlanIds(state.plans);   /* T1: 서버가 확인해 준 시점에만 표식을 정리한다 */
        persistPlansCache();
        state.plansBanner = null;
      } else {
        /* F7(Task 3 인계, 계약 K2): CONFIG(탭 없음·헤더 손상) 등 실패라도 캐시를 빈 목록으로
           덮어쓰지 않는다 — state.plans 를 건드리지 않고 마지막 저장본 + 동기화 시각을 그대로 보여준다. */
        state.plansBanner = (state.plans.length || state.plansSyncedAt)
          ? { level: 'warn', text: '예정된 점검 동기화 실패 — 마지막 저장본 사용 (' + result.error.code + ')' }
          : { level: 'error', text: '예정된 점검을 불러오지 못했습니다 (' + result.error.code + ')' };
      }
      if (state.currentScreen === 'home') renderHome();
    });
  }

  /* ---------- 홈: 새 점검/이어쓰기(계획 없이, adhoc) ---------- */
  function startNewInspection(template) {
    if (state.drafts && state.drafts.adhoc) {
      var ok = window.confirm('작성 중인 임시 점검이 있습니다. 새로 시작하면 기존 임시 점검은 삭제됩니다. 계속할까요?');
      if (!ok) return;
    }
    var draft = SafetyLogic.newDraft(template.template_id, template.ver, todayStr());
    state.draft = draft;
    state.draftKey = 'adhoc';
    state.drafts = state.drafts || {};
    state.drafts.adhoc = draft;
    state.writeStep = 1;
    clearBanner();
    state.lastSaveFailureKey = null;   /* 새 점검 = 새 고지 기회 */
    persistDraft();                    /* 저장 실패는 여기서 즉시 배너로 뜬다 */
    show('write');
  }
  function continueDraft() {
    var d = state.drafts && state.drafts.adhoc;
    if (!d) return;
    state.draft = d;
    state.draftKey = 'adhoc';
    state.writeStep = 2;
    clearBanner();
    show('write');
  }
  /* 계획에서 시작 — 이미 임시저장이 있으면 이어서, 없으면 계획 정보(점검일·협력회사·공사)로
     새 draft 를 만든다(설계 §6-3, renderWriteStep1 이 이 필드들을 잠근다).
     W1: 계획에 박힌 plan.template_ver 가 지금의 활성 양식 판본과 다르면(양식 개정 창을 걸친
     계획 — 스펙 §4-1 이 미래 365일 등록을 허용해 실제로 생긴다) 화면엔 새 판본 항목이
     그려지는데(getCurrentTemplateItems, 위) payload 는 옛 template_ver 를 실어 제출 순간
     lib.js validateSubmission 이 ITEMS_MISMATCH 로 거절한다 — 점검일·회사·공사가 잠겨 있고
     양식도 고를 수 없어(renderWriteStep1) 사용자가 화면 안에서 고칠 방법이 없다. 140문항을
     다 채운 뒤가 아니라 여기, 누르는 순간 막는다. 이미 작성 중이던 draft(이어서 작성)도
     같은 이유로 막는다 — 그대로 들여보내면 getCurrentTemplateItems 가 빈 배열을 돌려줘
     "이 양식에 등록된 항목이 없습니다"라는 더 헷갈리는 화면이 된다(작성한 내용 자체는 안
     지운다 — state.drafts 에 그대로 남아 있어 나중에 코드가 더 나아지면 복구할 여지가
     있다 — 여기서는 들어가는 문만 잠근다). masters 미수신·plan.template_ver 없음(옛 계획)은
     판정하지 않고 기존 동작 그대로 둔다(오판으로 정상 진입까지 막으면 안 된다). */
  function startFromPlan(plan) {
    if (state.masters && plan.template_ver != null && !findCurrentTemplate(plan.template_id, plan.template_ver)) {
      showBanner('error', "이 계획의 점검 양식이 개정되었습니다 — '새 점검 시작'으로 작성하거나 관리자에게 문의하세요.");
      window.scrollTo(0, 0);
      return;
    }
    var existing = state.drafts && state.drafts[plan.plan_id];
    if (existing) {
      state.draft = existing;
      state.draftKey = plan.plan_id;
      state.writeStep = 1;
      clearBanner();
      show('write');
      return;
    }
    /* 실제 점검일은 '작성 시점의 오늘'이지 계획 예정일이 아니다(H3). 계획 예정일을 inspect_date 에
       박으면 미래 계획은 제출 시 DATE_FUTURE, 31일 넘게 지난(지남) 계획은 DATE_TOO_OLD 로 거절되는데
       점검일 입력은 잠겨 있어(renderWriteStep1) 사용자가 고칠 수도 없다(lib.js validateDate 의
       기본 pastDays=31/futureDays=0, 제출 검증 기준 — 사전등록은 ±365일이라 범위가 다르다).
       예정일 자체는 화면 표시용으로만 planned_date_label 에 남긴다 — draftToPayload(logic.js)가
       필드 화이트리스트라 서버로는 새지 않는다(직접 확인함). */
    var draft = SafetyLogic.newDraft(plan.template_id, plan.template_ver, todayStr());
    draft.plan_id = plan.plan_id;
    draft.company_id = plan.company_id;
    draft.project_key = plan.project_key;
    draft.project_name = plan.project_name;
    draft.planned_date_label = plan.planned_date;
    state.draft = draft;
    state.draftKey = plan.plan_id;
    state.drafts = state.drafts || {};
    state.drafts[plan.plan_id] = draft;
    state.writeStep = 1;
    clearBanner();
    state.lastSaveFailureKey = null;
    persistDraft();
    show('write');
  }

  /* ---------- 사전등록 화면 ---------- */
  function openPlanForm() {
    state.planFormId = SafetyLogic.uuid();   /* 화면 진입 시 1회 — 재시도해도 같은 값(서버 멱등 전제) */
    $('p-date').value = todayStr();
    populateCompanySelect('p-company');
    $('p-company').value = '';
    populateProjectSelect('', { selectId: 'p-project', extraValue: '__NEW__', extraLabel: '새 공사 등록' });
    $('p-project-new-wrap').hidden = true;
    $('p-project-new').value = '';
    populatePlanTemplateSelect();
    populateTeamSelect('p-team');
    $('p-team').value = '';
    populateInspectorSelect('', 'p-inspector');
    $('p-pin').value = '';
    clearBanner();
    show('plan');
  }
  /* 활성 양식이 2개 이상일 때만 select 를 노출한다. 1개면 자동 선택하고 이름만 보여준다(브리프 §6-2). */
  function populatePlanTemplateSelect() {
    var tpls = activeTemplates();
    var sel = $('p-template');
    var single = $('p-template-single');
    if (tpls.length >= 2) {
      sel.hidden = false;
      single.hidden = true;
      sel.innerHTML = '';
      sel.appendChild(placeholderOption('양식 선택'));
      tpls.forEach(function (t) {
        var opt = document.createElement('option');
        opt.value = t.template_id; opt.textContent = t.name;
        sel.appendChild(opt);
      });
    } else {
      sel.hidden = true;
      single.hidden = false;
      single.textContent = tpls.length === 1 ? ('양식: ' + tpls[0].name) : '등록된 활성 양식이 없습니다.';
    }
  }
  function currentPlanTemplate() {
    var tpls = activeTemplates();
    var id = tpls.length === 1 ? tpls[0].template_id : $('p-template').value;
    return tpls.filter(function (t) { return t.template_id === id; })[0] || null;
  }
  function onPlanCompanyChange(e) {
    populateProjectSelect(e.target.value, { selectId: 'p-project', extraValue: '__NEW__', extraLabel: '새 공사 등록' });
    $('p-project-new-wrap').hidden = true;
    $('p-project-new').value = '';
  }
  function onPlanProjectChange(e) {
    var isNew = e.target.value === '__NEW__';
    $('p-project-new-wrap').hidden = !isNew;
    if (!isNew) $('p-project-new').value = '';
  }
  function onPlanTeamChange(e) {
    populateInspectorSelect(e.target.value, 'p-inspector');
  }
  function onCreatePlan() {
    if (state.creatingPlan) return;
    var date = $('p-date').value;
    var companyId = $('p-company').value;
    var projectSel = $('p-project').value;
    var isNewProject = projectSel === '__NEW__';
    var newProjectName = $('p-project-new').value.trim();
    var tpl = currentPlanTemplate();
    var inspectorId = $('p-inspector').value;
    var pin = $('p-pin').value;

    var missing = [], focusId = null;
    function mark(cond, label, id) { if (cond) { missing.push(label); focusId = focusId || id; } }
    mark(!date, '점검예정일', 'p-date');
    mark(!companyId, '협력회사', 'p-company');
    mark(!projectSel || (isNewProject && !newProjectName), '공사', isNewProject ? 'p-project-new' : 'p-project');
    mark(!tpl, '양식', 'p-template');
    mark(!inspectorId, '등록자', 'p-inspector');
    mark(!/^\d{4}$/.test(pin || ''), 'PIN(4자리)', 'p-pin');
    if (missing.length) {
      /* #banner-region 은 문서 최상단·비-sticky 다(H5) — 이 화면은 필드 7개라 375×667 에서
         하단 고정 액션바의 '등록'을 누르는 시점에 배너는 확실히 화면 밖이다. */
      showBanner('error', '다음 항목을 확인하세요: ' + missing.join(', '));
      window.scrollTo(0, 0);
      if (focusId) { var fel = $(focusId); if (fel && !fel.disabled && !fel.hidden) fel.focus(); }
      return;
    }

    var payload = {
      plan_id: state.planFormId,
      planned_date: date,
      company_id: companyId,
      project_key: isNewProject ? '' : projectSel,
      new_project_name: isNewProject ? newProjectName : '',
      template_id: tpl.template_id,
      template_ver: tpl.ver,
      inspector_id: inspectorId,
      pin: pin
    };
    /* 제출과 동일하게 PIN 을 주입한 마스터 사본으로 사전 검증한다(브리프 §6-2) */
    var mastersForValidate = withInjectedPin(state.masters || { inspectors: [] }, inspectorId, pin);
    var v = SafetyLib.validatePlan(payload, mastersForValidate, todayStr());
    if (!v.ok) {
      showBanner('error', v.errors.map(function (e) { return e.msg + '(' + e.code + ')'; }).join(' / '));
      window.scrollTo(0, 0);
      return;
    }
    state.creatingPlan = true;
    var btn = $('btn-plan-create');
    btn.disabled = true;
    btn.textContent = '등록 중...';
    /* H9: 요청이 떠 있는 동안(최대 25초, requestJson 타임아웃) 사용자가 뒤로가기·취소로 이
       화면을 떠나고 다시 새 사전등록을 시작할 수 있다 — openPlanForm 이 매번 planFormId 를
       새로 만든다. 요청 시작 시점의 id 를 지역 캡처해, 응답이 왔을 때 "그 요청을 보낸 화면이
       지금도 그대로인지" 를 판정한다(다른 화면을 빼앗지 않는다). 목록 반영(upsertPlan)은
       문맥과 무관하게 항상 한다 — 서버에 실제로 생긴 계획이라 화면이 바뀌었어도 숨기면 안 된다. */
    var reqPlanId = payload.plan_id;
    createPlanOnServer(payload).then(function (result) {
      var sameContext = (state.planFormId === reqPlanId);
      if (result.ok) {
        var d = result.data || {};
        /* H4: 서버가 채번한 공사·계획을 재조회 없이 즉시 흡수한다. refreshPlans/refreshMasters 는
           둘 다 세션당 온디맨드 호출(onCreatePlan 성공·init 뿐, 폴링 없음)이라, 여기서 흡수하지
           않으면 세션 내내 새 공사가 마스터에 없어 그 계획을 시작해 제출하면 PROJECT_UNKNOWN 으로
           거절되는데 공사 select 는 잠겨 있어(renderWriteStep1) 고칠 방법이 없다. */
        if (d.created_project) {
          upsertProject({ project_id: d.created_project.project_id, name: d.created_project.name,
                          company_id: payload.company_id, status: '진행' });
        }
        upsertPlan(d.plan);
        /* dup:true(같은 plan_id 재시도가 멱등으로 흡수된 응답)는 이번 화면의 입력이 반영되지
           않았다는 뜻이다(gas/main.gs 의 멱등 경로는 첫 성공 시점 값을 그대로 돌려준다) —
           신규 등록과 같은 '점검이 등록되었습니다.'를 띄우면 사용자가 오인한다. */
        showBanner(d.dup ? 'warn' : 'success',
          d.dup ? ('이미 등록된 계획입니다 — 이번 화면의 변경은 반영되지 않았습니다(등록된 예정일: '
                   + ((d.plan && d.plan.planned_date) || '확인 불가') + ')')
          : d.reused_project ? '이미 등록된 공사라 기존 공사로 연결했습니다.'
          : '점검이 등록되었습니다.');
        if (sameContext) { state.planFormId = null; show('home'); }
        refreshPlans();   /* 보조 — 실패해도 위에서 이미 로컬 정합이 맞다 */
        return;
      }
      if (!sameContext) return;   /* 화면을 이미 떠났다 — 남의 화면에 늦게 온 실패를 덮어씌우지 않는다 */
      /* 설계 §7: 계획 등록 실패는 큐에 넣지 않는다 — 화면에 머무르며 사유를 보여준다. */
      var err = normalizeError(result.error);
      var friendly = /PLAN_DUP/.test(err.message) ? '이미 처리된 계획입니다. 새로고침 후 다시 등록해 주세요.' : err.message;
      showBanner('error', '등록에 실패했습니다: ' + friendly + ' (' + err.code + ')');
      window.scrollTo(0, 0);
    }).finally(function () {
      state.creatingPlan = false;
      btn.disabled = false;          /* 화면을 떠났다 돌아와도 버튼이 잠긴 채로 남지 않는다(H9) */
      btn.textContent = '등록';
    }).catch(function (e) {
      showBanner('error', '등록 처리 중 오류가 발생했습니다: ' + ((e && e.message) || e));
      window.scrollTo(0, 0);
    });
  }
  /* 자동 재시도 대상 — 영구 실패(VALIDATION)는 재전송해도 같은 결과라 무한 재시도를 여기서 끊는다.
     그 항목은 큐 행의 '다시 시도'(사람의 명시적 의사)로만 다시 흐른다. */
  function autoRetryTargets() {
    return state.queue.filter(function (q) {
      if (q.state === 'pending') return true;
      return q.state === 'failed' && !isPermanentError(q.reason);
    });
  }
  function flushQueue() {
    if (state.syncing) return Promise.resolve();
    var targets = autoRetryTargets();
    if (!targets.length) return Promise.resolve();
    state.syncing = true;
    renderHome();
    var chain = Promise.resolve();
    /* H1: 큐에 있던 제출이 이번에 성공하면 그 계획도 done 이 된 것이다 — 로컬에서 즉시 지운다. */
    var removedPlan = false;
    targets.forEach(function (item) {
      chain = chain.then(function () {
        var payload = stripQueueMeta(item);
        return submitToServer(payload).then(function (result) {
          if (result.ok) {
            state.queue = SafetyLogic.queueReducer(state.queue, { type: 'SENT', id: payload.submission_id });
            if (removePlanLocally(payload.plan_id)) removedPlan = true;
          } else {
            markQueueFailure(payload.submission_id, normalizeError(result.error));
          }
          persistQueue();
        });
      });
    });
    /* finally: 어느 경로로 끝나든 syncing 을 반드시 푼다 — 여기서 새면 큐가 영구히 얼어붙는다 */
    return chain.finally(function () {
      state.syncing = false;
      if (removedPlan) refreshPlans();   /* 서버 진실로 최종 정합 — renderHome 은 이 안에서도 불린다 */
      if (state.currentScreen === 'home') renderHome();
    }).catch(function (e) {
      showBanner('error', '동기화 중 오류가 발생했습니다: ' + ((e && e.message) || e));
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
    /* 계획에서 시작한 작성은 점검일·협력회사·공사를 잠근다(읽기 전용) — 설계 §6-3.
       점검자·PIN·수검자는 계획에 없다(누가 갈지는 작성 시점에 정한다, 설계 §1) — 그대로 편집. */
    var locked = !!draft.plan_id;
    $('f-date').value = draft.inspect_date || todayStr();
    $('f-date').max = todayStr();
    /* disabled 대신 readonly(H6) — 포커스·탭 순서는 유지하고 값 수정만 막는다. disabled 입력은
       change 이벤트 자체를 안 쏘므로 그 성질을 오히려 이용한다: readonly 도 사용자 상호작용으로는
       값이 안 바뀌므로 onDateChange 가 잠긴 상태에서 발화할 길이 없다. */
    $('f-date').readOnly = locked;
    $('f-date').disabled = false;

    populateCompanySelect();
    $('f-company').value = draft.company_id || '';
    $('f-company').disabled = locked;
    populateProjectSelect(draft.company_id);
    if (/^TMP-/.test(draft.project_key || '')) {
      $('f-project').value = '__TMP__';
      $('f-project-tmp-wrap').hidden = false;
      $('f-project-tmp').value = draft.project_name || '';
    } else {
      $('f-project').value = draft.project_key || '';
      $('f-project-tmp-wrap').hidden = true;
    }
    /* 양방향 대입(H2) — populateProjectSelect 호출 뒤에 와야 한다(그 함수가 내부에서 한 번
       disabled 를 다시 계산한다). 예전에는 locked 일 때만 잠그고 푸는 코드가 없어, 계획 작성을
       한 번 시작하면 이후 adhoc(미등록 공사 직접 입력, 오프라인 탈출구) 입력칸이 새로고침
       전까지 죽어 있었다. */
    $('f-project').disabled = locked || !draft.company_id;
    $('f-project-tmp').disabled = locked;

    populateTeamSelect();
    var team = teamOf(draft.inspector_id);
    $('f-team').value = team || '';
    populateInspectorSelect(team);
    $('f-inspector').value = draft.inspector_id || '';

    $('f-pin').value = draft.pin || '';
    $('f-auditee').value = draft.auditee || '';

    /* 계획 컨텍스트 표시(H3·H6) — 실제 점검일은 오늘로 채워 잠그고(startFromPlan 참고), 계획
       예정일은 이 문구로만 보여준다. disabled select 는 선택된 값을 다른 곳에 노출하지 않으므로
       이 텍스트가 협력회사·공사·예정일을 읽을 수 있는 유일한 자리다(본문색, styles.css 참고). */
    var ctx = $('f-plan-context');
    if (locked) {
      ctx.hidden = false;
      ctx.textContent = '사전등록 계획: ' + (draft.planned_date_label || '') + ' · ' + companyName(draft.company_id) + ' · ' + (draft.project_name || '');
    } else {
      ctx.hidden = true;
    }
  }
  /* selectId 는 선택: 작성 화면(f-*)이 기본이고, 사전등록 화면(p-*)·계획 취소 패널(pc-*)이
     같은 채움 로직을 재사용한다(기존 호출부는 인자 없이 그대로 동작한다). */
  function populateCompanySelect(selectId) {
    var sel = $(selectId || 'f-company');
    sel.innerHTML = '';
    sel.appendChild(placeholderOption('협력회사 선택'));
    ((state.masters && state.masters.companies) || []).filter(function (c) { return c.active !== false; })
      .forEach(function (c) {
        var opt = document.createElement('option');
        opt.value = c.company_id; opt.textContent = c.name;
        sel.appendChild(opt);
      });
  }
  /* opts.selectId 기본 f-project. opts.extraValue/extraLabel 로 목록 끝 특수 옵션을 바꾼다 —
     작성 화면은 '미등록 공사(직접 입력)'(TMP, 오프라인 탈출구), 사전등록 화면은
     '새 공사 등록'(정식 공사만 만든다, 설계 §5) — 값·문구가 다르므로 하드코딩하지 않는다. */
  function populateProjectSelect(companyId, opts) {
    opts = opts || {};
    var sel = $(opts.selectId || 'f-project');
    sel.innerHTML = '';
    sel.appendChild(placeholderOption('공사 선택'));
    ((state.masters && state.masters.projects) || [])
      .filter(function (p) { return p.company_id === companyId && p.status === '진행'; })
      .forEach(function (p) {
        var opt = document.createElement('option');
        opt.value = p.project_id; opt.textContent = p.name;
        sel.appendChild(opt);
      });
    var extraOpt = document.createElement('option');
    extraOpt.value = opts.extraValue || '__TMP__';
    extraOpt.textContent = opts.extraLabel || '미등록 공사(직접 입력)';
    sel.appendChild(extraOpt);
    sel.disabled = !companyId;
  }
  function populateTeamSelect(selectId) {
    var sel = $(selectId || 'f-team');
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
  function populateInspectorSelect(team, selectId) {
    var sel = $(selectId || 'f-inspector');
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
    var digits = clampPinInput(e);
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
    if (draft.plan_id) payload.plan_id = draft.plan_id;   /* 서버가 성공 시 이 계획을 done 으로 전이한다(Task 3) */
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
      if (result.ok) {
        /* H1: 서버가 제출을 접수하면 그 계획은 done 으로 전이해 GET plans 에서 더 이상 내려오지
           않는다 — 재조회를 기다리지 않고 로컬에서도 즉시 지운다(오프라인이면 refreshPlans 가
           실패해 캐시가 그대로 남으므로 여기서 먼저 맞춰야 한다). clearActiveDraft 가 draft 를
           지우므로 payload.plan_id 로 먼저 캡처한다. */
        var donePlanId = payload.plan_id || null;
        removePlanLocally(donePlanId);
        var consumedOk = markPlanConsumed(donePlanId);   /* T1 — 목록에서 이미 지웠어도 표식은 남긴다(방어적).
          U1: 반환값(영속 성공 여부)을 아래에서 쓴다 — 실패해도 메모리 표식은 이미 서 있어 이번
          세션은 안전하지만, 이 기기를 새로고침하면 표식이 사라진다. */
        /* U1: tombstone 영속이 실패하면 초안을 지우지 않는다 — clearActiveDraft 를 건너뛰면
           state.drafts[plan_id]가 그대로 남아, 나중에 이 계획을 다시 열어도 startFromPlan(940행)이
           "기존 draft 재사용" 분기를 타 같은 submission_id(logic.js newDraft 가 한 번만 채번,
           draftToPayload 는 그 값을 그대로 읽는다)로 재제출된다 — 서버가 이미 처리한 submission_id
           라 dup 로 받아들여진다(바로 위 result.data.dup 분기가 이미 그 경우를 처리한다). 초안을
           지워버리면 다음 진입이 newDraft()로 새 submission_id 를 채번해 진짜 중복 위험이 생긴다. */
        var cleared = consumedOk ? clearActiveDraft() : false;   /* H8 — 반환값을 쓴다 */
        showBanner((cleared && consumedOk) ? 'success' : 'error',
          ((result.data && result.data.dup) ? '이미 처리된 제출입니다(중복 확인됨).' : '제출 완료.')
          + (!consumedOk
              ? ' 다만 이 기기에 제출 완료 표시를 저장하지 못해 작성 내용을 지우지 않고 남겨뒀습니다 — '
                + '서버에는 이미 기록되었으니 다시 작성하지 마세요. 이 계획을 나중에 다시 열면 방금 낸 '
                + '내용 그대로 이어지며 같은 제출로 처리됩니다. 저장소를 확인하세요.' + saveErrorSuffix()
              : (cleared ? '' : ' 다만 이 기기의 임시저장 삭제에 실패했습니다 — 앱을 다시 열면 제출된 점검이 임시저장으로 남아 있을 수 있습니다.' + saveErrorSuffix())));
        show('home');
        refreshPlans();   /* 서버 진실로 최종 정합(성공해도 실패해도 위에서 이미 로컬은 맞다) */
        return;
      }
      var err = normalizeError(result.error);
      if (isPermanentError(err.code)) {
        /* VALIDATION: 제출 내용 자체의 결함이라 같은 payload 는 몇 번을 보내도 거절된다.
           큐에 넣으면 무한 재시도가 되고, clearDraft 하면 유일한 작성본이 사라진다.
           → draft 를 그대로 둔 채 검토 화면에 머물러 사용자가 PIN·날짜 등을 고쳐 재제출하게 한다.
           (클라 사전검증은 withInjectedPin 때문에 PIN 오타를 구조적으로 못 잡는다 — 여기가 유일한 방어선) */
        showBanner('error', '서버가 제출을 거절했습니다 — 입력을 고쳐 다시 제출하세요: '
          + err.message + ' (' + err.code + ')');
        window.scrollTo(0, 0); /* 배너는 화면 최상단이다 — 스크롤된 상태면 거절 사실을 못 본다 */
        return;
      }
      /* CONFIG·AUTH·일시 오류·네트워크·비JSON: 큐 적재 후 홈으로 (자동 재시도 대상) */
      state.queue = SafetyLogic.queueReducer(state.queue, { type: 'ENQUEUE', item: payload });
      markQueueFailure(payload.submission_id, err);
      if (!state.storage.saveQueue(state.queue)) {
        /* 여기서 clearDraft 하면 유일한 기록이 사라진다 — 전송도 저장도 실패한 최악의 경로다.
           큐 적재를 되돌리고(영속되지 않은 행을 남기지 않는다) draft 를 살린 채 검토 화면에 붙잡아 둔다. */
        state.queue = state.queue.filter(function (x) { return x.submission_id !== payload.submission_id; });
        showBanner('error', '전송에 실패했고 미전송 목록 저장도 실패했습니다 — 이 기기의 저장소가 막혀 있습니다. '
          + '기록을 잃지 않도록 작성 내용을 이 화면에 그대로 둡니다. 연결을 확인한 뒤 다시 제출하세요: '
          + err.message + ' (' + err.code + ')' + saveErrorSuffix());
        window.scrollTo(0, 0);
        return;
      }
      var consumedOk2 = markPlanConsumed(payload.plan_id);   /* T1 — 큐 저장이 실제로 성공한 뒤에만 표식을 남긴다.
        큐 항목을 나중에 지워도 이 표식은 독립적으로 남아 재작성을 막는다(이 결함의 핵심).
        U1: 반환값(영속 성공 여부)을 아래에서 쓴다. */
      /* U1: 여기서도 tombstone 영속 실패 시 초안을 지우지 않는다(위 성공 분기와 같은 이유 —
         submission_id 를 재사용할 수 있는 유일한 사본을 남긴다). 큐 항목 자체는 이미
         saveQueue 로 영속을 확인했으니(위 1631행) 되돌리지 않는다 — 이 문제는 tombstone 이라는
         "두 번째 방어선"만의 문제고, 되돌려야 할 대상이 아니다. */
      var cleared2 = consumedOk2 ? clearActiveDraft() : false;   /* H8 — 반환값을 쓴다. 계획은 여기서 지우지 않는다(H1) —
        서버는 아직 이 계획을 done 으로 전이하지 않았다(제출이 큐에 있을 뿐이다). renderPlanList 의
        queuedPlanIdSet 이 이 큐 항목을 보고 '작성 시작'을 막는다. */
      showBanner('error', (isAdminError(err.code)
        ? ('전송 실패 — 큐에 보관됨. 관리자 확인이 필요합니다. 해결되면 자동으로 전송됩니다: ' + err.message + ' (' + err.code + ')')
        : ('전송 실패 — 큐에 보관됨: ' + err.message + ' (' + err.code + ')'))
        + (!consumedOk2
            ? ' 다만 이 기기에 재작성 방지 표시를 저장하지 못해 작성 내용을 지우지 않고 남겨뒀습니다 — '
              + '안전을 위한 것이니 그대로 두세요.' + saveErrorSuffix()
            : (cleared2 ? '' : ' (임시저장 삭제 실패' + saveErrorSuffix() + ')')));
      show('home');
    }).finally(function () {
      /* 어느 경로로 끝나든 submitting 을 반드시 푼다 — 여기서 새면 제출 버튼이 영구히 잠긴다 */
      state.submitting = false;
      if (state.currentScreen === 'review') renderReview();
    }).catch(function (e) {
      showBanner('error', '제출 처리 중 오류가 발생했습니다: ' + ((e && e.message) || e));
    });
  }

  /* ================= 기동 ================= */
  /* 마스터·계획 캐시는 draft·queue 와 같은 storage 래퍼(logic.js)를 거친다 — window.localStorage
     직접 접근 금지(감사 지적, tests-js/wiring.test.mjs §18c 가 app.js 전체를 스캔해 검사한다).
     래퍼가 이미 폴백(available:false 기기에서 세션 메모리로 계속 동작)·예외 무발생을 보장하므로
     여기서 별도 try/catch·메모리 캐시를 두지 않는다(계약 K4 전제 그대로 승계). */
  function loadCachedMasters() {
    var cached = state.storage.loadMasters();
    if (cached && cached.data) { state.masters = cached.data; state.mastersSyncedAt = cached.syncedAt || null; }
  }
  function refreshMasters() {
    return loadMastersFromNetwork().then(function (result) {
      if (result.ok) {
        state.masters = result.data;
        state.mastersSyncedAt = new Date().toISOString();
        state.storage.saveMasters({ data: state.masters, syncedAt: state.mastersSyncedAt });
        state.masterBanner = CONFIG.MOCK ? { level: 'info', text: 'MOCK 모드 — 내장 목 데이터 사용 중(서버 미연결)' } : null;
      } else {
        state.masterBanner = state.masters
          ? { level: 'warn', text: '마스터 동기화 실패 — 마지막 저장본 사용 (' + result.error.code + ')' }
          : { level: 'error', text: '마스터를 불러오지 못했습니다. 네트워크를 확인하세요 (' + result.error.code + ')' };
      }
      if (state.currentScreen === 'home') renderHome();
    });
  }
  /* 계획 캐시(sc_plans) — 마스터와 같은 패턴({data, syncedAt}) + T1 소비 표식(consumed). */
  function loadCachedPlans() {
    var cached = state.storage.loadPlans();
    if (cached && cached.data) { state.plans = cached.data; state.plansSyncedAt = cached.syncedAt || null; }
    if (cached && cached.consumed) { state.consumedPlanIds = cached.consumed; }
  }

  function wireEvents() {
    $('btn-back').addEventListener('click', onBack);
    $('btn-continue-draft').addEventListener('click', continueDraft);
    $('btn-sync-now').addEventListener('click', flushQueue);

    $('btn-open-plan-form').addEventListener('click', openPlanForm);
    $('btn-plan-form-cancel').addEventListener('click', function () {
      if (state.creatingPlan) return;   /* H9 — 요청 진행 중 이탈 금지 */
      clearBanner(); show('home');
    });
    $('btn-plan-create').addEventListener('click', onCreatePlan);
    $('p-company').addEventListener('change', onPlanCompanyChange);
    $('p-project').addEventListener('change', onPlanProjectChange);
    $('p-team').addEventListener('change', onPlanTeamChange);
    $('p-pin').addEventListener('input', clampPinInput);
    $('pc-team').addEventListener('change', function (e) { populateInspectorSelect(e.target.value, 'pc-inspector'); });
    $('pc-pin').addEventListener('input', clampPinInput);
    $('btn-plan-cancel-close').addEventListener('click', closePlanCancelPanel);
    $('btn-plan-cancel-confirm').addEventListener('click', onPlanCancelConfirm);

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

  /* 손상 계열 op 판정 — logic.js(storage 래퍼)가 원본을 백업하고 빈 값으로 복구하는 두 경우를
     한 곳에서 묶는다: 'parse'(JSON 자체를 못 읽음)·'type'(JSON 은 읽히지만 맵이어야 할 자리에
     배열/null/문자열/숫자가 들어 있음, logic.js M3). 둘 다 backupCorrupt()를 거쳐 lastError 에
     같은 모양({op, key, backup_key, backup_saved, backup_full, message})을 남긴다 — 사용자
     입장에서는 "쓰던 게 사라지고 백업만 남았다"는 같은 사건이다. 앞으로 손상 유형이 더 늘어도
     이 술어 하나만 넓히면 큐·임시저장 양쪽에 동시 반영된다(S1). */
  function isCorruptOp(op) {
    return op === 'parse' || op === 'type';
  }
  /* 손상 복구는 조용히 지나가면 안 된다(계약 K4) — 무엇이 사라졌고 어디에 백업됐는지 알려준다.
     문구는 op 를 가리지 않는다 — "손상되어 백업에 보관했습니다"는 parse(못 읽음)·type(모양이
     틀림) 어느 쪽이든 사실 그대로다(사용자는 파싱 실패와 형태 오류를 구분해 알 필요가 없다). */
  function corruptNotice(subject, err) {
    var where = err.backup_saved ? ('(백업 키: ' + err.backup_key + ')')
      : (err.backup_full ? '(백업 슬롯이 가득 차 이번 손상본은 보관하지 못했습니다)' : '(백업 저장에도 실패했습니다)');
    return subject + ' 손상되어 백업에 보관했습니다' + where;
  }
  function init() {
    state.storage = SafetyLogic.storage(window);
    state.queue = state.storage.loadQueue();
    /* lastError 는 '직전 호출'의 결과다 — 다음 호출이 첫 줄에서 null 로 덮어쓰므로 여기서 먼저 읽는다 */
    var queueErr = state.storage.lastError;
    /* 옛 단일 슬롯(sc_draft)을 sc_drafts['adhoc']으로 이전 — loadAllDrafts 보다 먼저 호출해야
       이전된 값이 바로 아래 로드에 반영된다(설계 §6-4). */
    var migrated = state.storage.migrateLegacyDraft();
    var migrateErr = state.storage.lastError;
    state.drafts = state.storage.loadAllDrafts();
    var draftsErr = state.storage.lastError;
    loadCachedMasters();
    loadCachedPlans();
    wireEvents();
    show('home');
    var notices = [];
    if (queueErr && isCorruptOp(queueErr.op)) notices.push(corruptNotice('미전송 목록이', queueErr));
    /* migrateLegacyDraft() 결과 5종(logic.js 실측, 'none'·'migrated' 는 정상 무통보) — 계약 K4:
       'collision'/'copied' 를 조용히 흘리면 사용자가 옛 기기에 남은 미완성 점검의 존재를
       영영 모른다(그 draft 는 storage.saveDraft/loadDraft 가 계속 관리하므로 사라지지 않았을
       뿐 — 화면에 안 나타나는 게 문제다). 모르는 값도 최소한 드러낸다(값 자체를 노출) — 이
       분기가 앞으로 나올 새 결과값까지 조용히 삼키지 않게 하는 안전판이다. */
    if (migrated === 'failed') {
      notices.push('이전 버전 임시저장을 옮기지 못했습니다' +
        (migrateErr ? (' (' + migrateErr.op + ': ' + migrateErr.message + ')') : ''));
    } else if (migrated === 'collision') {
      notices.push('이전 버전에서 작성하던 임시저장이 이 기기에 남아 있습니다. 지금 작성 중인 건을 ' +
        '제출하거나 지운 뒤 앱을 다시 열면 이어서 쓸 수 있습니다.');
    } else if (migrated === 'copied') {
      notices.push('이전 버전 임시저장은 새 저장 방식으로 옮겨졌지만, 옛 저장분을 지우지 못해 ' +
        '기기에 중복으로 남아 있습니다(지금 작성 화면 동작에는 영향이 없습니다).');
    } else if (migrated !== 'none' && migrated !== 'migrated') {
      notices.push('임시저장 이전 결과를 알 수 없습니다(상태: ' + migrated + '). 작성 중이던 점검이 ' +
        '있었다면 홈에서 보이는지 확인하세요.');
    }
    if (draftsErr && isCorruptOp(draftsErr.op)) notices.push(corruptNotice('작성 중이던 점검이', draftsErr));
    if (notices.length) showBanner('error', notices.join(' / '));
    refreshMasters();
    refreshPlans();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
