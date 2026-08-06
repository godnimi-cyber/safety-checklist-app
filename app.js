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
    /* 관리 화면에서 손대고 있는 계획과 그 방식('edit' 예정일 변경 / 'cancel' 취소).
       두 동작이 패널 하나를 공유하므로 어느 쪽인지가 상태로 있어야 한다. */
    managingPlan: null,
    managingMode: null,
    managingPlanBusy: false,
    /* 취소하려는 제출(오늘 보낸 목록의 한 건)과 처리 중 표식 */
    voiding: null,
    voidingBusy: false,
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
     시딩하고(데모가 언제 열어도 지난/오늘/다가옴 3그룹이 보이게), 관리 화면 날짜칸의 ±365
     경계(min·max)를 서버 규칙과 같은 값으로 계산한다. */
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
  function updatePlanOnServer(payload) {
    return CONFIG.MOCK ? mockPlanUpdate(payload) : realPlanUpdate(payload);
  }
  function voidSubmissionOnServer(payload) {
    return CONFIG.MOCK ? mockSubmissionVoid(payload) : realSubmissionVoid(payload);
  }
  function realSubmissionVoid(payload) {
    return requestJson(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'submission_void', k: CONFIG.SHARED_KEY, payload: payload }),
      redirect: 'follow'
    });
  }
  function mockSubmissionVoid(payload) {
    // eslint-disable-next-line no-console
    console.log('[MOCK submission_void]', payload);
    return new Promise(function (resolve) {
      setTimeout(function () { resolve({ ok: true, data: { voided: true, findings: 0 } }); }, 200);
    });
  }
  function realPlanUpdate(payload) {
    return requestJson(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'plan_update', k: CONFIG.SHARED_KEY, payload: payload }),
      redirect: 'follow'
    });
  }
  /* MOCK plan_update: 서버의 멱등 규칙(같은 날짜면 updated:false)만 흉내 낸다 — PIN 은 검증하지
     않는다(데모 목적, 서버가 검증할 자리가 없다. mockPlanCancel 과 같은 수준). */
  function mockPlanUpdate(payload) {
    // eslint-disable-next-line no-console
    console.log('[MOCK plan_update]', payload);
    return new Promise(function (resolve) {
      setTimeout(function () {
        var hit = ensureMockPlans().filter(function (p) { return p.plan_id === payload.plan_id; })[0];
        if (!hit) { resolve({ ok: false, error: { code: 'VALIDATION', message: 'PLAN_NOT_FOUND' } }); return; }
        var same = hit.planned_date === payload.planned_date;
        hit.planned_date = payload.planned_date;
        resolve({ ok: true, data: { updated: !same, planned_date: payload.planned_date } });
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
    $('screen-manage').hidden = name !== 'manage';
    updateTopbar(name);
    if (name === 'home') { renderHome(); flushQueue(); }
    else if (name === 'write') { renderWrite(); }
    else if (name === 'review') { renderReview(); }
    else if (name === 'manage') { renderManage(); }
    window.scrollTo(0, 0);
  }
  function updateTopbar(name) {
    var title = $('topbar-title');
    var back = $('btn-back');
    if (name === 'home') { title.textContent = '안전점검'; back.hidden = true; }
    else if (name === 'write') { title.textContent = state.writeStep === 1 ? '작성 · 기본정보' : '작성 · 항목점검'; back.hidden = false; }
    else if (name === 'review') { title.textContent = '검토'; back.hidden = false; }
    else if (name === 'plan') { title.textContent = '점검 사전등록'; back.hidden = false; }
    else if (name === 'manage') { title.textContent = '예정 점검 관리'; back.hidden = false; }
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
    if (state.currentScreen === 'plan') { show('home'); return; }
    /* H9 와 같은 이유 — 수정·취소 요청이 떠 있는 동안 이탈을 막는다. 떠나도 요청은 흐르지만,
       응답이 늦게 와 남의 화면에 배너를 던지는 경합 창을 좁힌다. */
    if (state.currentScreen === 'manage' && state.managingPlanBusy) return;
    if (state.currentScreen === 'manage') { closePlanManagePanel(); show('home'); }
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
    renderPlanTeams();
    renderPlanList();
    renderSentList();

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
      $('home-continue-label').textContent = draftLabel(adhocDraft);
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
  var ALL_TEAMS = '__all__';
  /* 팀 목록을 코드에 박지 않는다 — 빠진 팀의 예정 점검이 어느 필터에서도 안 보이게 되고,
     그건 이 앱에서 가장 나쁜 고장이다(점검을 통째로 놓친다). 마스터의 팀과 **실제 계획에
     들어 있는 팀**의 합집합으로 만든다: 마스터에 없는 팀(퇴사·소속 변경)도 사라지지 않는다. */
  function planTeams() {
    var seen = {}, out = [];
    function add(t) {
      var v = String(t || '');
      if (!v || seen[v]) return;
      seen[v] = 1; out.push(v);
    }
    ((state.masters && state.masters.inspectors) || []).forEach(function (i) { add(i.team); });
    (state.plans || []).forEach(function (p) { add(p.team); });
    out.sort();
    /* 팀을 알 수 없는 계획(등록자가 마스터에서 사라졌거나 옛 서버) — 칩이 없으면 '전체'
       외에는 어디에도 안 보인다. 있을 때만 맨 뒤에 둔다. */
    if ((state.plans || []).some(function (p) { return !String(p.team || ''); })) out.push('');
    return out;
  }
  function planMatchesTeam(p) {
    /* `||` 를 쓰면 안 된다 — 「팀 미상」의 값은 빈 문자열이라 falsy 여서 전체로 새어 나간다
       (실측: 팀 미상을 골랐는데 전부 나왔다). 고르지 않은 상태(null/undefined)만 전체다. */
    var f = (state.planTeamFilter == null) ? ALL_TEAMS : state.planTeamFilter;
    if (f === ALL_TEAMS) return true;
    return String(p.team || '') === f;
  }
  /* 선택지에 건수를 붙인다 — 고르기 전에 어디에 몇 건이 있는지 보이고, 거르면 무엇이
     가려지는지도 드러난다. 0건인 팀도 남긴다: 목록에서 빼면 "우리 팀이 사라졌다" 가 된다. */
  function planTeamCount(team) {
    return (state.plans || []).filter(function (p) {
      return team === ALL_TEAMS || String(p.team || '') === team;
    }).length;
  }
  function renderPlanTeams() {
    var wrap = $('home-plans-teams');
    var sel = $('home-plans-team');
    var teams = planTeams();
    sel.innerHTML = '';
    /* 팀이 하나뿐이면 고를 것이 없다 — 필터 줄만 자리를 먹는다. */
    wrap.hidden = teams.length < 2;
    if (wrap.hidden) return;
    var cur = (state.planTeamFilter == null) ? ALL_TEAMS : state.planTeamFilter;   /* 빈 문자열 = 팀 미상 */
    [{ v: ALL_TEAMS, label: '전체' }].concat(teams.map(function (t) {
      return { v: t, label: t || '팀 미상' };
    })).forEach(function (opt) {
      var o = document.createElement('option');
      o.value = opt.v;
      o.textContent = opt.label + ' (' + planTeamCount(opt.v) + ')';
      sel.appendChild(o);
    });
    sel.value = cur;
  }
  function setPlanTeamFilter(v) {
    state.planTeamFilter = v;
    renderPlanTeams();
    renderPlanList();
  }
  function onPlanTeamChange() { setPlanTeamFilter($('home-plans-team').value); }
  function renderPlanList() {
    var wrap = $('home-plans-list');
    wrap.innerHTML = '';
    var today = todayStr();
    /* 이미 그 계획으로 작성해 큐에 넣은 제출이 있으면(전송 대기 중) '작성 시작'을 다시 누르게
       두면 안 된다 — 새 submission_id 로 또 작성하면 서버 멱등에 안 걸려 점검대장에 2행이
       남는다(H1). 계획은 서버에서 아직 planned 이므로 목록에는 남기되 시작을 막는다. */
    var queued = queuedPlanIdSet(state.queue);
    var all = (state.plans || []);
    var plans = all.filter(planMatchesTeam).slice().sort(function (a, b) {
      var ga = planGroup(a, today), gb = planGroup(b, today);
      if (ga !== gb) return ga - gb;
      if (a.planned_date < b.planned_date) return -1;
      if (a.planned_date > b.planned_date) return 1;
      return 0;
    });
    /* 건수는 **거르기 전 전체**를 보여준다 — 거른 수를 보이면 "예정 점검이 줄었다" 로 읽힌다. */
    $('home-plans-badge').hidden = all.length === 0;
    $('home-plans-badge').textContent = String(all.length);
    /* 비었을 때 이유를 구분해 말한다. 거르기 때문에 비었는데 "예정된 점검이 없습니다" 라고
       하면, 남은 점검을 없는 것으로 믿고 넘어간다 — 놓치는 경로다(K4). */
    var emptyEl = $('home-plans-empty');
    emptyEl.hidden = plans.length !== 0;
    emptyEl.textContent = (all.length === 0)
      ? '예정된 점검이 없습니다.'
      : (state.planTeamFilter === ALL_TEAMS || state.planTeamFilter == null
          ? '예정된 점검이 없습니다.'
          : '이 팀의 예정 점검이 없습니다 — 다른 팀 것 ' + all.length + '건은 「전체」에서 볼 수 있습니다.');
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
      /* 계획별 임시저장도 버릴 수 있어야 한다 — 없으면 그 계획을 통째로 취소하는 것이 유일한
         탈출로가 되고, 그건 계획까지 잃는 과한 대가다(K3). 임시저장이 있을 때만 보인다. */
      var dropBtn = node.querySelector('.plan-btn-discard');
      if (hasDraft && !queued[p.plan_id] && !isConsumed) {
        dropBtn.hidden = false;
        dropBtn.addEventListener('click', function () { discardDraft(p.plan_id); });
      } else {
        dropBtn.hidden = true;
      }

      wrap.appendChild(node);
    });
  }
  /* 오늘 보낸 점검 — 미전송 큐 **아래**에 둔다. 위(미전송)는 할 일이고 여기는 끝난 일이라,
     순서를 바꾸면 눈이 먼저 닿는 자리를 끝난 일이 차지한다.
     예정 점검·임시저장과 같은 순서로 적는다(날짜 · 공사 · 협력회사) — 같은 것을 다르게
     적으면 세 목록을 서로 대조할 수 없다. */
  function renderSentList() {
    var wrap = $('home-sent-list');
    wrap.innerHTML = '';
    var list = (state.sent || []).slice().sort(function (a, b) {
      return String(a.sent_at) < String(b.sent_at) ? 1 : -1;   /* 최근에 보낸 것이 위 */
    });
    $('home-sent-empty').hidden = list.length !== 0;
    $('home-sent-badge').hidden = list.length === 0;
    $('home-sent-badge').textContent = String(list.length);
    list.forEach(function (s) {
      var node = $('tpl-sent-row').content.firstElementChild.cloneNode(true);
      node.querySelector('.sent-when').textContent = formatDateTime(s.sent_at) + ' 전송';
      node.querySelector('.sent-project').textContent = s.project_name || '(공사 미상)';
      node.querySelector('.sent-company').textContent =
        (s.company_name || '') + (s.inspect_date ? ' · 점검일 ' + s.inspect_date : '');
      /* 이 기능이 생기기 전에 보낸 기록에는 판정이 없다 — 뽑을 수 없는 버튼을 보이면
         눌러 보고 오류만 만난다. 버튼을 아예 내지 않는다(하루면 자연히 사라진다). */
      var pbtn = node.querySelector('.sent-btn-print');
      pbtn.hidden = !s.template_id;
      pbtn.addEventListener('click', function () { printSheet(printDataFromSent(s)); });
      node.querySelector('.sent-btn-void').addEventListener('click', function () { openVoidPanel(s); });
      wrap.appendChild(node);
    });
  }
  /* 제출 취소 — 본인이 **오늘 보낸** 것만. 점검자를 고르는 칸이 없다: 제출자가 이미
     정해져 있으므로 고를 수 없고, 고를 수 없으면 잘못 고를 수도 없다. PIN 만 받고
     서버가 제출자와 대조한다(권한이 새로 생기지 않는다 — 자기 것을 자기 PIN 으로 무른다). */
  function openVoidPanel(sent) {
    if (state.voidingBusy) {
      showBanner('warn', '앞선 요청을 처리하는 중입니다 — 끝난 뒤 다시 눌러 주세요.');
      window.scrollTo(0, 0);
      return;
    }
    state.voiding = sent;
    $('void-target').textContent = (sent.project_name || '(공사 미상)') + ' · ' + (sent.company_name || '')
      + ' 제출을 취소합니다. 취소하면 통계에서 빠지고, 되돌리려면 새로 작성해 제출해야 합니다.';
    $('void-pin').value = '';
    $('void-panel').hidden = false;
    $('void-panel').scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
  }
  function closeVoidPanel() {
    state.voiding = null;
    $('void-panel').hidden = true;
  }
  function onVoidConfirm() {
    if (state.voidingBusy || !state.voiding) return;
    var target = state.voiding;
    var pin = $('void-pin').value;
    if (!/^\d{4}$/.test(pin || '')) {
      showBanner('error', 'PIN(4자리)을 확인하세요.');
      window.scrollTo(0, 0);
      var el = $('void-pin'); if (el && !el.disabled) el.focus();
      return;
    }
    state.voidingBusy = true;
    var btn = $('btn-void-confirm');
    var label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '취소 처리 중...';
    voidSubmissionOnServer({ submission_id: target.submission_id,
      inspector_id: target.inspector_id, pin: pin }).then(function (result) {
      if (result.ok) {
        /* 목록에서 뺀다 — 취소된 것을 '오늘 보낸' 목록에 남겨 두면 또 취소하려 든다. */
        state.sent = (state.sent || []).filter(function (r) { return r.submission_id !== target.submission_id; });
        state.storage.saveSent(state.sent, todayStr());
        closeVoidPanel();
        var f = (result.data && result.data.findings) || 0;
        showBanner('success', '제출을 취소했습니다.' + (f ? ' 부적합 ' + f + '건도 함께 정리했습니다.' : ''));
        renderHome();
        return;
      }
      var err = normalizeError(result.error);
      showBanner('error', '취소에 실패했습니다: ' + friendlyVoidError(err.message) + ' (' + err.code + ')');
      window.scrollTo(0, 0);
    }).catch(function (e) {
      showBanner('error', '취소 처리 중 오류가 발생했습니다: ' + ((e && e.message) || e));
      window.scrollTo(0, 0);
    }).finally(function () {
      state.voidingBusy = false;
      btn.disabled = false;
      btn.textContent = label;
    });
  }
  function friendlyVoidError(message) {
    return /NOT_YOUR_SUBMISSION/.test(message) ? '본인이 제출한 점검만 취소할 수 있습니다.'
      : /VOID_WINDOW_CLOSED/.test(message) ? '오늘 보낸 점검만 앱에서 취소할 수 있습니다 — 지난 것은 관리자에게 요청하세요.'
      : /SUBMISSION_NOT_FOUND/.test(message) ? '서버에 없는 제출입니다. 목록을 새로고침하세요.'
      : /PIN_MISMATCH/.test(message) ? 'PIN이 일치하지 않습니다.'
      : /SUBMISSION_DUPLICATE/.test(message) ? '같은 제출이 장부에 두 번 있습니다 — 관리자에게 알리세요.'
      : message;
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
  /* ================= 예정 점검 관리 화면 =================
     설계 2026-08-05-plan-manage §4. 탭 바가 없는 앱이라 화면 하나를 더한다.
     권한은 서버와 같다 — 명부에 있는 점검자면 자기 PIN 으로 남의 계획도 손댈 수 있다(등록자
     구속을 하면 등록자가 휴가·퇴사일 때 계획이 굳는다). 누가 바꿨는지는 시트 이력에 남는다. */
  function renderManage() {
    /* 동기화 실패를 이 화면에서도 드러낸다(K4) — 홈의 renderPlansBanner 와 같은 상태를 읽는다.
       이게 없으면 관리 화면에서는 목록이 왜 안 바뀌는지 알 방법이 없다. */
    var bn = $('manage-banner');
    if (!state.plansBanner) { bn.hidden = true; }
    else {
      bn.hidden = false;
      bn.className = 'banner banner-' + state.plansBanner.level;
      bn.textContent = state.plansBanner.text;
    }
    var wrap = $('manage-plans-list');
    wrap.innerHTML = '';
    var today = todayStr();
    var queued = queuedPlanIdSet(state.queue);
    /* 관리 화면은 예정일 오름차순 하나로만 정렬한다 — 홈의 3그룹 정렬(지남/오늘/다가옴)은
       '무엇부터 수행하나'를 위한 것이고, 여기서는 '언제 것을 손보나'라 날짜순이 곧 찾는 순서다. */
    var plans = (state.plans || []).slice().sort(function (a, b) {
      if (a.planned_date < b.planned_date) return -1;
      if (a.planned_date > b.planned_date) return 1;
      return 0;
    });
    $('manage-empty').hidden = plans.length !== 0;
    plans.forEach(function (p) {
      var node = $('tpl-manage-plan-row').content.firstElementChild.cloneNode(true);
      var overdue = p.planned_date < today;
      var dateEl = node.querySelector('.plan-date');
      dateEl.textContent = p.planned_date + (overdue ? ' · 지남' : '');
      dateEl.classList.toggle('plan-overdue', overdue);
      node.querySelector('.plan-project').textContent = p.project_name;
      node.querySelector('.plan-company').textContent = p.company_name;

      var editBtn = node.querySelector('.plan-btn-edit');
      var cancelBtn = node.querySelector('.plan-btn-cancel');
      var noteEl = node.querySelector('.plan-note');
      /* 어떤 상태에서도 버튼을 막지 않는다. tombstone(consumedPlanIds)은 "서버가 완료했다"가
         아니라 "이 기기에서 내보냈다(큐 적재 포함)"는 뜻이다 — 사용자가 큐 항목을 지우면
         서버 계획은 여전히 planned 인데 표식만 남는다. 그때 버튼을 막으면 이 기기에서는
         영영 못 고치는 막다른 길이 된다(K3 위반. Codex 렌즈B #4 로 발각).
         서버가 최종 판정을 하고(done 이면 PLAN_ALREADY_DONE), 앱은 그것을 사람 말로 옮긴다.
         대신 무슨 일이 벌어질지는 미리 알린다. */
      var isConsumed = !!(state.consumedPlanIds && state.consumedPlanIds[p.plan_id]);
      editBtn.addEventListener('click', function () { openPlanManagePanel(p, 'edit'); });
      /* 미전송 제출이 있는 계획의 **취소만** 막는다(2차 검증 #7). 취소하면 계획은 canceled 인데
         나중에 그 제출이 전송돼 점검 기록이 생긴다 — 서버 linkPlanDone_ 은 bestEffort 라
         canceled 를 done 으로 되돌리지 않으므로 "취소된 계획인데 실제 점검 기록이 있는" 모순이
         영구히 남는다. 기록을 버리지 않는 건 맞지만 완료된 현장 작업을 취소로 분류하게 된다.
         이건 막다른 길이 아니다(1차 #4 와 다른 점): 홈 미전송 목록에서 **전송하거나 삭제**하면
         바로 풀린다. 그 탈출로를 문구로 가리킨다. 예정일 변경은 계획이 남으므로 모순이 없다. */
      if (queued[p.plan_id]) {
        cancelBtn.disabled = true;
        noteEl.hidden = false;
        noteEl.textContent = '이 기기의 미전송 목록에 이 계획으로 작성한 제출이 있어 취소할 수 없습니다 — 홈에서 전송하거나 그 항목을 삭제한 뒤 다시 시도하세요.';
      } else {
        cancelBtn.addEventListener('click', function () { openPlanManagePanel(p, 'cancel'); });
        if (isConsumed) {
          noteEl.hidden = false;
          noteEl.textContent = '이 기기에서 이미 제출을 내보낸 계획입니다 — 서버가 완료 처리했다면 변경·취소가 거절됩니다.';
        } else {
          noteEl.hidden = true;
        }
      }
      wrap.appendChild(node);
    });

    /* 재조회가 state.plans 를 새 배열로 갈면, 열려 있던 패널은 **옛 객체**를 잡고 있다.
       그대로 두면 다른 기기에서 취소된 계획을 계속 편집하게 되고(확정해야 서버 오류로 알게 된다),
       날짜가 바뀐 계획은 패널이 옛 날짜를 보인다. plan_id 로 새 객체에 다시 묶고, 사라졌으면
       닫고 알린다(Codex 렌즈B #2). 처리 중에는 건드리지 않는다 — 진행 중인 요청의 대상이다. */
    if (state.managingPlan && !state.managingPlanBusy) {
      var cur = state.managingPlan;
      var fresh = plans.filter(function (x) { return x.plan_id === cur.plan_id; })[0];
      if (!fresh) {
        closePlanManagePanel();
        showBanner('warn', '편집 중이던 계획이 목록에서 사라졌습니다 — 다른 기기에서 처리되었을 수 있습니다.');
      } else if (fresh.planned_date !== cur.planned_date) {
        /* 값이 실제로 달라졌을 때만 다시 연다 — 무조건 다시 열면 입력 중이던 PIN·점검자가
           재조회 한 번에 지워진다. 날짜가 바뀌었으면 보고 있는 값이 거짓이므로 다시 여는 게 맞다. */
        openPlanManagePanel(fresh, state.managingMode);
        showBanner('warn', '이 계획의 예정일이 ' + fresh.planned_date + ' 로 바뀌었습니다 — 확인 후 진행하세요.');
      } else {
        state.managingPlan = fresh;   /* 참조만 새 객체로 — 입력 중인 값은 건드리지 않는다 */
      }
    }
  }
  function openPlanManagePanel(plan, mode) {
    /* 처리 중에는 다른 대상·다른 모드로 갈아타지 못하게 막는다. 안 막으면 응답이 오기 전에
       패널이 다른 계획으로 바뀌고, finally 가 옛 버튼 문구('변경 확정')를 되살려 취소 모드
       패널에 변경 문구가 뜬다 — 사용자가 의도하지 않은 취소를 누를 수 있다.
       (요청 자체는 클로저의 plan 을 쓰므로 서버로 가는 값은 어긋나지 않는다. 막는 것은 화면의 거짓말이다.) */
    if (state.managingPlanBusy) {
      /* 무시하고 끝내면 눌러도 아무 일이 없는 버튼이 된다(K4) — 왜 안 되는지 말한다. */
      showBanner('warn', '앞선 요청을 처리하는 중입니다 — 끝난 뒤 다시 눌러 주세요.');
      window.scrollTo(0, 0);
      return;
    }
    state.managingPlan = plan;
    state.managingMode = mode;
    var isEdit = mode === 'edit';
    /* H7(취소에만 해당): 이 계획으로 작성 중인 임시저장이 있으면 취소와 함께 사라진다는 걸
       미리 알린다 — 계획이 목록에서 빠지면 '이어서 작성' 진입점 자체가 없어지기 때문이다.
       예정일 변경은 계획이 남으므로 임시저장도 그대로 살아 있다. */
    var hasDraft = !!(state.drafts && state.drafts[plan.plan_id]);
    $('plan-manage-target').textContent = plan.planned_date + ' · ' + plan.company_name + ' · ' + plan.project_name
      + (isEdit ? ' 계획의 예정일을 변경합니다. 점검자 인증 후 확정됩니다.'
                : ' 계획을 취소합니다. 점검자 인증 후 확정됩니다.')
      + (!isEdit && hasDraft ? ' 이 계획에 작성 중인 내용이 있으며 취소하면 함께 삭제됩니다.' : '');
    $('pm-date-field').hidden = !isEdit;
    /* 서버와 같은 ±365일을 입력칸에도 건다 — 서버가 최종 판정이지만, 오프라인·느린 회선에서
       왕복 한 번을 기다린 뒤에야 "범위 밖"을 아는 것은 막다른 길처럼 느껴진다. */
    $('pm-date').min = shiftDateStr(-365);
    $('pm-date').max = shiftDateStr(365);
    $('pm-date').value = isEdit ? plan.planned_date : '';
    populateTeamSelect('pm-team');
    $('pm-team').value = '';
    populateInspectorSelect('', 'pm-inspector');
    $('pm-pin').value = '';
    $('btn-plan-manage-confirm').textContent = isEdit ? '변경 확정' : '취소 확정';
    $('plan-manage-panel').hidden = false;
    $('plan-manage-panel').scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
  }
  function closePlanManagePanel() {
    state.managingPlan = null;
    state.managingMode = null;
    $('plan-manage-panel').hidden = true;
  }
  /* 서버 오류 코드를 사용자가 고칠 수 있는 말로 옮긴다(Task 3 findings F4/F5 와 같은 관용구).
     수정·취소가 같은 코드 집합을 쓰므로 한 곳에 둔다 — 한쪽만 고쳐 문구가 갈라지지 않게. */
  function friendlyPlanError(message) {
    return /PLAN_ALREADY_DONE/.test(message) ? '이미 완료된 점검입니다. 목록을 새로고침하세요.'
      : /PLAN_ALREADY_CANCELED/.test(message) ? '이미 취소된 계획입니다. 목록을 새로고침하세요.'
      : /PLAN_NOT_FOUND/.test(message) ? '이미 처리되었거나 없는 계획입니다. 목록을 새로고침하세요.'
      : /PLAN_DATE_INVALID/.test(message) ? '예정일이 허용 범위(오늘 기준 ±1년)를 벗어났습니다.'
      : /PIN_MISMATCH/.test(message) ? 'PIN이 일치하지 않습니다.'
      /* CONFLICT 계열 — 요청도 설정도 잘못되지 않았다. 그 사이 누가(사람이 시트에서) 먼저
         손댔을 뿐이다. 자동 재시도는 하지 않는다: 바뀐 값을 보지도 않고 덮어쓰게 된다. */
      : /PLAN_ROW_MOVED/.test(message) ? '그 사이 이 계획이 옮겨졌거나 사라졌습니다. 목록을 새로 받았으니 다시 확인하세요.'
      : /PLAN_STATE_CHANGED/.test(message) ? '그 사이 이 계획의 상태가 바뀌었습니다. 목록을 새로 받았으니 다시 확인하세요.'
      : /PLAN_CELL_CHANGED/.test(message) ? '그 사이 다른 곳에서 이 계획을 고쳤습니다. 목록을 새로 받았으니 값을 확인하고 다시 시도하세요.'
      : /PLAN_ID_DUPLICATE/.test(message) ? '같은 계획이 장부에 두 번 들어 있습니다 — 관리자에게 알리세요.'
      : /PLAN_CELL_HAS_FORMULA/.test(message) ? '이 계획 행에 수식이 들어 있어 고칠 수 없습니다 — 관리자에게 알리세요.'
      : message;
  }
  function onPlanManageConfirm() {
    if (state.managingPlanBusy || !state.managingPlan) return;
    var plan = state.managingPlan;
    var isEdit = state.managingMode === 'edit';
    var newDate = $('pm-date').value;
    var inspectorId = $('pm-inspector').value;
    var pin = $('pm-pin').value;
    var missing = [], focusId = null;
    if (isEdit && !newDate) { missing.push('새 점검예정일'); focusId = focusId || 'pm-date'; }
    if (!inspectorId) { missing.push('점검자'); focusId = focusId || 'pm-inspector'; }
    if (!/^\d{4}$/.test(pin || '')) { missing.push('PIN(4자리)'); focusId = focusId || 'pm-pin'; }
    if (missing.length) {
      /* #banner-region 은 문서 최상단·비-sticky 다(H5) — 패널은 scrollIntoView 로 화면 가운데에
         있어, 배너만 띄우면 위로 스크롤된 실패 사실을 못 본다. */
      showBanner('error', '다음 항목을 확인하세요: ' + missing.join(', '));
      window.scrollTo(0, 0);
      if (focusId) { var fel = $(focusId); if (fel && !fel.disabled) fel.focus(); }
      return;
    }
    /* 서버와 같은 ±365 를 여기서도 본다(min/max 는 브라우저마다 강제력이 다르고 직접 입력을
       막지 못한다). 오프라인이면 왕복 자체가 없어 서버 판정이 오지 않는다 — 그때 "범위 밖"을
       알려주는 것은 이 검사뿐이다(Codex 렌즈B #6). 최종 판정은 여전히 서버다. */
    if (isEdit && (newDate < shiftDateStr(-365) || newDate > shiftDateStr(365))) {
      showBanner('error', '예정일은 오늘 기준 ±1년 안에서만 지정할 수 있습니다.');
      window.scrollTo(0, 0);
      var del = $('pm-date'); if (del && !del.disabled) del.focus();
      return;
    }
    /* 오프라인이어도 큐에 넣지 않는다(설계 §4) — 나중에 보내면 의미가 옅어지고, 갇힌 요청이
       중복 조작을 만든다. 실패하면 화면에 머무르며 사유를 보인다. */
    state.managingPlanBusy = true;
    var btn = $('btn-plan-manage-confirm');
    var label = btn.textContent;
    btn.disabled = true;
    btn.textContent = isEdit ? '변경 처리 중...' : '취소 처리 중...';
    var req = isEdit
      ? updatePlanOnServer({ plan_id: plan.plan_id, planned_date: newDate, inspector_id: inspectorId, pin: pin })
      : cancelPlanOnServer({ plan_id: plan.plan_id, inspector_id: inspectorId, pin: pin });
    req.then(function (result) {
      if (result.ok) {
        if (isEdit) applyPlanUpdated(plan, newDate);
        else applyPlanCanceled(plan);
        return;
      }
      var err = normalizeError(result.error);
      showBanner('error', (isEdit ? '예정일 변경에 실패했습니다: ' : '취소에 실패했습니다: ')
        + friendlyPlanError(err.message) + ' (' + err.code + ')');
      window.scrollTo(0, 0);
      /* 충돌은 "내가 보고 있는 목록이 낡았다" 는 뜻이다 — 사용자가 같은 낡은 값으로 다시
         누르지 않도록 서버 진실을 즉시 다시 받는다(패널은 renderManage 가 재결합한다). */
      if (String(err.code) === 'CONFLICT') refreshPlans();
    }).catch(function (e) {
      showBanner('error', (isEdit ? '예정일 변경 중 오류가 발생했습니다: ' : '취소 처리 중 오류가 발생했습니다: ')
        + ((e && e.message) || e));
      window.scrollTo(0, 0);
    }).finally(function () {
      state.managingPlanBusy = false;
      btn.disabled = false;
      btn.textContent = label;
    });
  }
  /* 성공 후 로컬 진실을 먼저 맞추고(오프라인 전환·재조회 실패에도 화면이 거짓말하지 않게),
     서버 재조회는 보조 정합으로 뒤에 돌린다 — upsertPlan/removePlanLocally 와 같은 원칙(H4). */
  function applyPlanUpdated(plan, newDate) {
    (state.plans || []).forEach(function (p) { if (p.plan_id === plan.plan_id) p.planned_date = newDate; });
    bumpPlansGeneration();   /* 이 변경 이전에 시작된 조회 응답은 옛 날짜를 담고 있다(#9) */
    persistPlansCache();
    closePlanManagePanel();
    showBanner('success', '예정일을 ' + newDate + ' 로 변경했습니다.');
    renderManage();
    refreshPlans();   /* 서버 진실로 최종 정합(성공해도 실패해도 위에서 이미 로컬은 맞다) */
  }
  function applyPlanCanceled(plan) {
    state.plans = (state.plans || []).filter(function (p) { return p.plan_id !== plan.plan_id; });
    bumpPlansGeneration();   /* 낡은 응답이 취소한 계획을 되살리지 못하게(#9) */
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
    closePlanManagePanel();
    showBanner(clearedOk ? 'success' : 'error',
      '점검 계획을 취소했습니다.' + (hadDraft ? (clearedOk ? ' 작성 중이던 내용도 삭제했습니다.'
        : ' 다만 이 기기의 임시저장 삭제에 실패했습니다 — 저장소를 확인하세요.' + saveErrorSuffix()) : ''));
    renderManage();
    refreshPlans();
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
  /* 보낸 사실을 로컬에 남긴다. **제출을 막지 않는다** — 저장이 실패해도 서버에는 이미
     기록됐으므로 되돌릴 것이 없고, 여기서 배너를 띄우면 "제출 완료" 를 덮어써 오히려 겁준다.
     조용히 넘기는 유일한 저장 실패다(K4 예외): 잃는 것이 기록이 아니라 **보기 편의**뿐이다. */
  function recordSent(payload) {
    if (!payload || !payload.submission_id) return;
    var today = todayStr();
    state.sent = (state.sent || []).filter(function (r) { return r.submission_id !== payload.submission_id; });
    /* 인쇄에 필요한 것을 **그때 값으로** 함께 담는다. 나중에 마스터가 바뀌어도(퇴사·공사 종료)
       종이에는 제출 당시의 이름이 나와야 한다 — 그게 그 점검의 사실이다.
       results 는 70여 개라 하루치가 몇 KB 수준이고, 당일분만 보관하므로 쌓이지 않는다. */
    state.sent.push({
      submission_id: payload.submission_id,
      sent_date: today,
      sent_at: new Date().toISOString(),
      inspect_date: payload.inspect_date || '',
      company_name: companyName(payload.company_id) || '',
      project_name: payload.project_name || projectName(payload.project_key) || '',
      inspector_id: payload.inspector_id || '',
      inspector_name: inspectorDisplay(payload.inspector_id) || '',
      auditee: payload.auditee || '',
      auditee_ack: !!payload.auditee_ack,
      template_id: payload.template_id,
      template_ver: payload.template_ver,
      results: payload.results || []
    });
    state.storage.saveSent(state.sent, today);
  }
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
    bumpPlansGeneration();   /* 낡은 응답이 제출로 사라진 계획을 되살리지 못하게(#9) */
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
    bumpPlansGeneration();   /* 낡은 응답이 방금 등록한 계획을 지우지 못하게(#9) */
    persistPlansCache();
  }
  /* 계획 상태의 세대 번호(2차 검증 #9). 수정·취소가 성공하면 올린다 — 그 시점 이전에 시작된
     조회의 응답은 **바뀌기 전 목록**을 담고 있어, 늦게 도착하면 방금 바꾼 상태와 캐시를
     되돌린다(옛 날짜가 살아나고 취소한 계획이 다시 나타난다. 그 뒤 조회가 없으면 그대로 남는다).
     조회는 시작 시점의 세대를 기억했다가, 응답 시점에 세대가 그대로일 때만 반영한다. */
  /* 설치·오프라인이 막혔을 때 **어느 층에서** 막혔는지 태블릿에서 읽을 수 있게 한다.
     원격에서 볼 수 없는 값들이라, 이게 없으면 추측밖에 할 수 없다. */
  /* **지금 이 창**이 독립 실행인지. 설치해 두고 브라우저 탭에서 열면 false 다 —
     그래서 이것만으로 "설치됐는가" 를 판단하면 안 된다(그게 첫 판의 오탐이었다). */
  function inStandalone() {
    try {
      return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
             window.navigator.standalone === true;
    } catch (e) { return false; }
  }
  /* **기기에** 설치되어 있는가. manifest 의 related_applications 에 자기 자신을 넣어 두고
     브라우저에 되묻는다. 못 묻는 브라우저에서는 null(모름) — 모르는 것을 안다고 하지 않는다. */
  function probeInstalled() {
    if (inStandalone()) { state.appInstalled = true; return; }
    if (!navigator.getInstalledRelatedApps) { state.appInstalled = null; return; }
    try {
      navigator.getInstalledRelatedApps().then(function (apps) {
        state.appInstalled = !!(apps && apps.length);
        if (state.currentScreen === 'home') renderDiagnostics();
      }).catch(function () { state.appInstalled = null; });
    } catch (e) { state.appInstalled = null; }
  }
  function installRow_() {
    if (state.installPrompt) return { v: '받음 — 아래 버튼으로 설치할 수 있습니다', bad: false };
    /* 브라우저는 **이미 설치된 사이트에 신호를 다시 보내지 않는다.** 그러니 "못 받음" 은
       그 자체로는 고장이 아니다. **설치가 아니라고 아는 경우에만** 빨갛게 칠한다 —
       아직 안 물어봤거나(undefined) 물을 수 없는 브라우저(null)는 단정할 근거가 없다.
       독립 실행 창이면 창 자체가 증거라 물어볼 것도 없다. */
    if (state.appInstalled === true || inStandalone()) {
      return { v: '안 옴 — 이미 설치되어 있어서 정상입니다', bad: false };
    }
    if (state.appInstalled === false) {
      return { v: '못 받음 — 설치되어 있지 않은데 신호가 안 옵니다. 기기 정책이 막고 있을 수 있습니다',
               bad: true };
    }
    return { v: '못 받음 — 이미 설치되었거나, 브라우저·기기 정책이 막고 있습니다(이 브라우저에서는 구분 불가)',
             bad: false };
  }
  function diagRows() {
    var standalone = inStandalone();
    var secure = (typeof window.isSecureContext === 'boolean')
      ? window.isSecureContext : (location.protocol === 'https:');
    var run = standalone ? '설치됨(독립 실행)'
      : (state.appInstalled === true ? '설치됨 — 지금은 브라우저에서 보는 중'
                                     : '브라우저에서 실행 중');
    var inst = installRow_();
    return [
      { k: '앱 버전', v: CONFIG.APP_VER, bad: false },
      { k: '실행 방식', v: run, bad: false },
      { k: '보안 연결', v: secure ? '정상(HTTPS)' : '아님 — 설치도 오프라인도 불가',
        bad: !secure },
      { k: '서비스워커', v: (state.swState || '확인 중') + (state.swDetail ? ' — ' + state.swDetail : ''),
        bad: state.swState === '실패' || state.swState === '미지원' },
      { k: '설치 신호', v: inst.v, bad: inst.bad },
      { k: '주소', v: location.origin + location.pathname, bad: false },
      { k: '브라우저', v: navigator.userAgent, bad: false }
    ];
  }
  function renderDiagnostics() {
    var list = $('diag-list');
    if (!list) return;
    list.innerHTML = '';
    diagRows().forEach(function (r) {
      var row = document.createElement('div');
      row.className = 'diag-row';
      var dt = document.createElement('dt');
      dt.textContent = r.k;
      var dd = document.createElement('dd');
      dd.className = r.bad ? 'bad' : 'ok';
      dd.textContent = r.v;
      row.appendChild(dt); row.appendChild(dd);
      list.appendChild(row);
    });
    $('btn-install').hidden = !state.installPrompt;
  }
  function toggleDiagnostics() {
    var body = $('diag-body');
    var open = body.hidden;
    body.hidden = !open;
    $('btn-diag-toggle').textContent = open ? '접기' : '펼치기';
    $('btn-diag-toggle').setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) { probeInstalled(); renderDiagnostics(); }
  }
  /* 브라우저 메뉴의 「설치」가 숨거나 막힌 환경이 있다 — 이벤트를 잡아 두면 앱 안의 버튼에서
     같은 설치를 띄울 수 있다. 이벤트 자체가 안 오면 설치 조건이나 기기 정책 문제다. */
  function onInstallPrompt(e) {
    if (e && e.preventDefault) e.preventDefault();
    state.installPrompt = e;
    if (state.currentScreen === 'home') renderDiagnostics();
  }
  function doInstall() {
    var p = state.installPrompt;
    if (!p) return;
    state.installPrompt = null;
    $('btn-install').hidden = true;
    try {
      p.prompt();
      if (p.userChoice && p.userChoice.then) {
        p.userChoice.then(function (r) {
          $('diag-install-hint').textContent = (r && r.outcome === 'accepted')
            ? '설치를 시작했습니다.'
            : '설치를 취소했습니다. 「앱 상태」를 다시 펼치면 버튼이 돌아옵니다.';
        });
      }
    } catch (e) {
      $('diag-install-hint').textContent = '설치를 띄우지 못했습니다: ' + String((e && e.message) || e);
    }
  }
  function bumpPlansGeneration() { state.plansGen = (state.plansGen || 0) + 1; }
  /* 조회 응답의 역전을 막는 장치가 **둘** 필요하다(3차 검증 #8).
     - plansGen: 조회가 도는 동안 로컬 수정·취소가 성공하면 그 응답은 낡았다
     - plansSeq: 조회끼리도 도착 순서가 뒤집힌다. 늦게 보낸 R2 가 먼저 도착해 반영된 뒤
       R1 이 도착하면 최신 목록이 옛 목록으로 되돌아간다 — 세대만으로는 이걸 못 막는다.
       **가장 마지막에 시작한 조회만** 반영한다. */
  function refreshPlans(retriesLeft) {
    var gen = state.plansGen || 0;
    var seq = state.plansSeq = (state.plansSeq || 0) + 1;
    /* 재조회 상한 — 매번 세대가 밀리면(사용자가 계속 조작 중) 무한 재귀가 된다. */
    var left = (retriesLeft == null) ? 2 : retriesLeft;
    return loadPlansFromNetwork().then(function (result) {
      if (seq !== state.plansSeq) return;   /* 더 나중에 시작한 조회가 있다 — 이 응답은 버린다 */
      if ((state.plansGen || 0) !== gen) {
        /* 이 조회가 도는 동안 수정·취소가 성공했다 — 이 응답은 이미 낡았다. 조용히 버리지
           않고 새 조회를 걸어 최종 정합을 맞춘다(버리기만 하면 화면이 로컬 낙관값에 머문다). */
        if (left > 0) return refreshPlans(left - 1);
        /* 상한 소진 — 조용히 포기하면 사용자는 목록이 왜 낡았는지 알 수 없다(K4).
           로컬 낙관값은 맞아 있으므로 데이터는 안전하다. 다시 맞추라고 알린다. */
        state.plansBanner = { level: 'warn', text: '예정 점검 동기화를 마치지 못했습니다 — 잠시 후 새로고침하세요.' };
        if (state.currentScreen === 'home') renderHome();
        else if (state.currentScreen === 'manage') renderManage();
        return;
      }
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
      /* 계획을 보여주는 화면은 둘이다 — 홈과 관리. 홈만 다시 그리면 관리 화면에 머무는 동안
         state.plans 가 새 배열로 갈렸는데 화면은 옛 목록을 계속 보인다(다른 사람이 취소·추가한
         계획이 안 보이거나 이미 사라진 계획이 남는다). */
      if (state.currentScreen === 'home') renderHome();
      else if (state.currentScreen === 'manage') renderManage();
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
  /* 임시저장을 식별하는 한 줄. 예정 점검 행과 **같은 순서**(날짜 · 공사 · 협력회사)로 적는다 —
     같은 것을 다르게 적으면 사용자가 둘을 대조하지 못한다.
     공사는 작성 1단계에서 고르므로 아직 비어 있을 수 있다. 그때 양식명만 적으면 "어느 공사인지
     모르겠다" 는 원래 문제로 돌아가므로, **아직 안 골랐다는 사실 자체를** 말한다. */
  function draftLabel(d) {
    var parts = ['작성 중: ' + d.inspect_date];
    if (d.project_name) parts.push(d.project_name);
    else if (d.project_key) parts.push(projectName(d.project_key));
    else parts.push('공사 미선택');
    if (d.company_id) parts.push(companyName(d.company_id));
    return parts.join(' · ');
  }
  /* 작성 중이던 것을 버린다. 지금까지는 '새 점검 시작' 으로 덮어쓰는 것이 유일한 경로였다 —
     지우려고 다른 걸 만들어야 하는 막다른 길이었다(K3).
     PIN 은 묻지 않는다: 임시저장은 이 폰에만 있어 PIN 이 보호하는 것이 없다(설계 §6).
     대신 되돌릴 수 없으므로 확인을 받고, 삭제 실패를 조용히 삼키지 않는다(K4). */
  function discardDraft(key) {
    var d = state.drafts && state.drafts[key];
    if (!d) return;
    if (!window.confirm(draftLabel(d) + '\n\n작성 중이던 내용을 삭제합니다. 되돌릴 수 없습니다. 계속할까요?')) return;
    var ok = state.storage.clearDraft(key);
    delete state.drafts[key];
    if (state.draftKey === key) { state.draft = null; state.draftKey = null; }
    showBanner(ok ? 'success' : 'error', ok ? '작성 중이던 내용을 삭제했습니다.'
      : '삭제에 실패했습니다 — 이 기기의 저장소를 확인하세요.' + saveErrorSuffix());
    window.scrollTo(0, 0);
    renderHome();
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
            recordSent(payload);   /* 큐에 있다가 나중에 나간 것도 '오늘 보낸' 것이다 */
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

  /* 일괄처리는 여러 카드의 표시를 한꺼번에 바꿔야 한다. 화면을 통째로 다시 그리면 스크롤
     위치와 아코디언 상태가 튀므로, 카드별 paint() 를 여기 등록해 두고 필요한 것만 다시 그린다.
     buildStep2 진입 시 비운다 — 옛 카드의 클로저가 남아 사라진 DOM 을 그리지 않게. */
  var cardPainters = {};

  /* 기본안전수칙 item_id -> 그 분류의 세부 항목을 감싼 <details>.
     적합·부적합이면 펼치고, 해당없음이면 접은 채로 일괄 처리한다. cardPainters 와 같은
     이유로 buildStep2 마다 비운다(옛 DOM 을 붙잡지 않게). */
  var subBoxOf = {};

  /* 기본안전수칙(group)에서 '해당없음' 을 고르면 같은 분류의 일반 안전수칙(item)을 함께 처리한다.
     - '해당없음' 일 때만 작동한다. Y/N 으로 바꿔도 하위는 건드리지 않는다(이미 답한 것을 지우지 않는다).
     - 잠그지 않는다 — 그 뒤 개별 항목을 자유롭게 되돌릴 수 있다.
     - note 행과 다른 group 행은 대상이 아니다(답이 없거나 자기 자신).
     - 머리 행이 note 인 분류(협력회사 SHE계획서 이행점검)는 발동시킬 group 이 없어 대상이 아니다.
     반환: 실제로 바뀐 item_id 배열. 이미 해당없음이던 것은 빼므로 멱등이고 알림 개수도 정확하다. */
  function cascadeNaToCategory(groupItem) {
    var changed = [];
    /* 분류가 비어 있으면 일괄하지 않는다. 아래 비교는 양쪽 빈 값을 '' 로 합치므로,
       분류 없는 양식(T1·T2 는 전 항목이 category='')에 group 행이 하나라도 생기면
       그것을 해당없음으로 고르는 순간 **양식 전체**가 해당없음이 된다.
       지금 데이터엔 그런 group 이 없어 발화하지 않지만, 항목 개정 한 번이면 열린다. */
    if (!(groupItem.category || '')) return changed;
    getCurrentTemplateItems().forEach(function (it) {
      if (it.type !== 'item') return;
      if ((it.category || '') !== (groupItem.category || '')) return;
      var cur = state.draft.results[it.item_id];
      if (cur && cur.r === 'NA') return;
      state.draft.results[it.item_id] = { r: 'NA' };
      changed.push(it.item_id);
    });
    return changed;
  }

  function buildStep2() {
    var root = $('accordion-root');
    root.innerHTML = '';
    cardPainters = {};
    subBoxOf = {};
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
      /* 기본안전수칙(group)이 있는 분류만 세부 항목을 접는다 — 70개가 한 번에 펼쳐지면
         스크롤을 감당할 수 없다. 접는 상자를 <details> 로 두면 키보드·스크린리더가 이미
         아는 구조이고, 사용자가 언제든 직접 펼칠 수 있어 "개별로 바꿀 수 있다"는 약속이 산다.
         머리 행이 note 인 분류(협력회사 SHE계획서 이행점검)는 펼칠 버튼이 될 group 이 없다
         → 접지 않는다. 접으면 그 항목들에 영영 답할 수 없다. */
      var headGroup = null, subItems = [];
      group.items.forEach(function (it) {
        if (it.type === 'group' && !headGroup) headGroup = it; else subItems.push(it);
      });
      if (headGroup && subItems.length) {
        body.appendChild(buildItemCard(headGroup));
        var subBox = document.createElement('details');
        subBox.className = 'sub-items';
        /* 이어 쓰던 점검에서 이미 답한 항목이 있으면 열어 둔다 — 접으면 한 일이 안 보인다. */
        subBox.open = subItems.some(function (it) { return !!state.draft.results[it.item_id]; });
        var subSummary = document.createElement('summary');
        subSummary.className = 'sub-items-summary';
        var subLabel = document.createElement('span');
        subLabel.textContent = '일반 안전수칙 ' +
          subItems.filter(function (it) { return it.type !== 'note'; }).length + '개';
        subSummary.appendChild(subLabel);
        subSummary.appendChild(chevronNode());
        subBox.appendChild(subSummary);
        var subBody = document.createElement('div');
        subBody.className = 'sub-items-body';
        subItems.forEach(function (it) {
          subBody.appendChild(it.type === 'note' ? buildNoteBox(it) : buildItemCard(it));
        });
        subBox.appendChild(subBody);
        body.appendChild(subBox);
        subBoxOf[headGroup.item_id] = subBox;
      } else {
        group.items.forEach(function (it) {
          body.appendChild(it.type === 'note' ? buildNoteBox(it) : buildItemCard(it));
        });
      }
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
    var cascadeNote = node.querySelector('.cascade-note');

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
    cardPainters[it.item_id] = paint;
    segButtons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var r = btn.dataset.r;
        var prev = state.draft.results[it.item_id];
        var prevNote = (prev && prev.n) || '';
        state.draft.results[it.item_id] = (r === 'N') ? { r: r, n: prevNote } : { r: r };
        /* 기본안전수칙을 해당없음으로 고르면 같은 분류의 세부 항목도 함께 처리한다.
           해당없음이 아닌 값으로 바꿀 때는 안내를 지운다 — 더는 사실이 아니기 때문이다. */
        var cascaded = [];
        if (it.type === 'group') {
          var box = subBoxOf[it.item_id];
          if (r === 'NA') {
            cascaded = cascadeNaToCategory(it);
            cascaded.forEach(function (id) { if (cardPainters[id]) cardPainters[id](); });
            /* 접은 채로 둔다 — 해당없음이면 세부를 볼 이유가 없다. 필요하면 사용자가 직접 편다. */
            if (box) box.open = false;
          } else if (box) {
            /* 적합·부적합은 둘 다 편다. 부적합이면 어느 세부 항목 때문인지 남겨야 하므로
               적합보다 더 필요하다. */
            box.open = true;
          }
        }
        invalidateAck();
        /* paint() 를 안내보다 **먼저** 부른다. 부적합(사유 미입력) 상태의 그룹을 해당없음으로
           바꾸는 순서에서, paint() 가 늦으면 .is-invalid 틴트 배경이 남은 채 안내가 먼저 붙는다.
           같은 이벤트 안이라 화면에 그려지지는 않지만, 그 조합의 대비는 4.5:1 을 밑돈다
           — 불변식이 순간이라도 깨지지 않게 순서로 막는다. */
        paint();
        if (cascadeNote) {
          if (cascaded.length) {
            cascadeNote.textContent = '이 분류의 하위 ' + cascaded.length +
              '개 항목을 해당없음으로 함께 처리했습니다. 필요하면 개별로 바꿀 수 있습니다.';
            cascadeNote.hidden = false;
          } else if (r !== 'NA') {
            cascadeNote.hidden = true;
          }
        }
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
    /* 접힌 상자가 두 겹이다(분류 아코디언 + 세부 항목 상자). 하나만 펼치면 스크롤은 가는데
       화면에는 아무것도 안 보인다 — 조상 details 를 전부 편다. */
    var box = card.closest('details');
    while (box) {
      box.open = true;
      box = box.parentElement ? box.parentElement.closest('details') : null;
    }
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
  /* 인쇄 전용 DOM 을 지금 상태로 다시 그린다(설계 2026-08-05-print-sheet §2).
     원본 수기 양식과 같은 표를 만든다 — 내용 │ Y N N/A │ 내용(부적합 사유) │ 점검기준.
     화면 표시가 아니라 **종이 기록**이므로, 판정은 고른 것만 찍는다(원본은 셋 다 인쇄해 두고
     손으로 동그라미를 쳤지만, 이미 정해진 값을 셋 다 보여주면 무엇이 답인지 흐려진다). */
  /* 검토 화면(작성 중)과 「오늘 보낸 점검」(제출 후)이 **같은 렌더를 쓴다** —
     둘이 갈라지면 종이 두 종류가 생기고, 고칠 때 한쪽만 고치게 된다. */
  function printDataFromDraft() {
    var d = state.draft;
    if (!d) return null;
    return {
      items: getCurrentTemplateItems(),
      inspect_date: d.inspect_date || '',
      project_name: d.project_name || projectName(d.project_key) || '',
      company_name: companyName(d.company_id) || '',
      auditee: d.auditee || '',
      inspector_name: inspectorDisplay(d.inspector_id) || '',
      auditee_ack: !!d.auditee_ack,
      byId: d.results || {}
    };
  }
  /* 보낸 기록에서 — 이름은 **담아 둔 값**을 쓴다(마스터가 바뀌어도 그때의 사실이 나온다).
     항목 문구는 그 제출이 쓴 (양식, 버전)에서 가져온다. */
  function printDataFromSent(s) {
    var tpl = findCurrentTemplate(s.template_id, s.template_ver);
    if (!tpl) return null;                       /* 양식이 개정돼 그 버전이 없다 */
    var byId = {};
    (s.results || []).forEach(function (r) { if (r && r.i) byId[r.i] = { r: r.r, n: r.n }; });
    return {
      items: tpl.items || [],
      inspect_date: s.inspect_date || '',
      project_name: s.project_name || '',
      company_name: s.company_name || '',
      auditee: s.auditee || '',
      inspector_name: s.inspector_name || '',
      auditee_ack: !!s.auditee_ack,
      byId: byId
    };
  }
  function renderPrintSheet(data) {
    var d = data;
    if (!d) return false;
    var items = d.items || [];
    if (!items.length) return false;

    $('print-date').textContent = d.inspect_date || '';
    $('print-project').textContent = d.project_name || '';
    $('print-company').textContent = d.company_name || '';
    $('print-auditee').textContent = d.auditee || '';
    $('print-inspector').textContent = d.inspector_name || '';
    /* 수검자 확인은 앱의 기록이지 서명이 아니다 — 인쇄물에도 그대로 '확인함' 으로만 적는다
       (설계 §4: 서명란은 원본에 없고 만들지 않는다). */
    $('print-ack').textContent = d.auditee_ack ? '확인함' : '';

    var tb = $('print-rows');
    tb.innerHTML = '';
    items.forEach(function (it) {
      var tr = document.createElement('tr');
      var isNote = it.type === 'note';
      var isGroup = it.type === 'group';
      if (isGroup) tr.className = 'g';
      var tdText = document.createElement('td');
      tdText.className = 'c-text';
      tdText.textContent = it.text || '';
      tr.appendChild(tdText);

      if (isNote) {
        /* 안내문은 판정이 없다 — 원본 70행([협력회사 SHE계획서 이행점검])과 같다.
           나머지 칸을 합쳐 문장이 잘리지 않게 한다. */
        tdText.colSpan = 5;
        tdText.className = 'c-text c-note-row';
        tb.appendChild(tr);
        return;
      }
      var entry = d.byId[it.item_id];
      var r = entry && entry.r;
      ['Y', 'N', 'NA'].forEach(function (kind) {
        var td = document.createElement('td');
        td.className = 'c-res';
        td.textContent = (r === kind) ? 'O' : '';
        tr.appendChild(td);
      });
      var tdNote = document.createElement('td');
      tdNote.className = 'c-note';
      tdNote.textContent = (entry && entry.n) || '';
      tr.appendChild(tdNote);
      /* 점검기준 열은 인쇄하지 않는다(사용자 요청) — 점검자가 판정할 때 보는 참고자료지
         기록의 일부가 아니다. 그 폭을 내용에 돌려 A4 한 장에 넣는다. 기준은 앱 화면과
         시트 출력양식에 그대로 있다. */
      tb.appendChild(tr);
    });
    return true;
  }
  /* 인쇄는 브라우저 기능을 그대로 쓴다 — 외부 라이브러리 0(설계 §2).
     폰에서는 이 창이 '인쇄' 대화상자로 열리고 거기서 PDF 로 저장한다. */
  function printSheet(data) {
    if (!renderPrintSheet(data)) {
      showBanner('error', '인쇄할 내용을 만들지 못했습니다 — 이 점검이 쓴 양식 판본을 찾지 못했습니다.');
      window.scrollTo(0, 0);
      return;
    }
    var el = $('print-sheet');
    el.hidden = false;
    try { window.print(); }
    finally { el.hidden = true; }   /* 실패해도 화면에 인쇄용 표가 남지 않게 한다 */
  }
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
        recordSent(payload);   /* 오늘 보낸 목록에 남긴다(제출 흐름을 막지 않는다) */
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
    $('btn-discard-draft').addEventListener('click', function () { discardDraft('adhoc'); });
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
    $('btn-void-close').addEventListener('click', closeVoidPanel);
    $('btn-void-confirm').addEventListener('click', onVoidConfirm);
    $('void-pin').addEventListener('input', clampPinInput);
    $('btn-open-plan-manage').addEventListener('click', function () { clearBanner(); show('manage'); });
    $('pm-team').addEventListener('change', function (e) { populateInspectorSelect(e.target.value, 'pm-inspector'); });
    $('pm-pin').addEventListener('input', clampPinInput);
    $('btn-plan-manage-close').addEventListener('click', closePlanManagePanel);
    $('btn-plan-manage-confirm').addEventListener('click', onPlanManageConfirm);

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
    $('btn-print').addEventListener('click', function () { printSheet(printDataFromDraft()); });
    $('home-plans-team').addEventListener('change', onPlanTeamChange);
    $('btn-diag-toggle').addEventListener('click', toggleDiagnostics);
    $('btn-install').addEventListener('click', doInstall);
    window.addEventListener('beforeinstallprompt', onInstallPrompt);
    window.addEventListener('appinstalled', function () {
      state.installPrompt = null;
      state.appInstalled = true;
      $('diag-install-hint').textContent = '설치가 끝났습니다. 홈 화면 아이콘으로 여세요.';
      if (state.currentScreen === 'home') renderDiagnostics();
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
  /* 서비스워커 등록 — 설치 아이콘과 오프라인 콜드스타트를 얻는다(sw.js 주석 참고).
     **앱 시작을 막지 않는다**: 등록이 실패해도(사설 인증서·시크릿 모드·구형 브라우저)
     앱은 그대로 돌아야 한다. 오프라인 콜드스타트만 안 될 뿐 지금까지와 같다.
     실패를 배너로 띄우지도 않는다 — 사용자가 할 수 있는 게 없고, 매번 뜨면 진짜 경고를 가린다. */
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) { setSwState('미지원', '이 브라우저에 서비스워커가 없습니다'); return; }
    try {
      navigator.serviceWorker.register('./sw.js').then(function (reg) {
        setSwState('등록됨', reg && reg.scope ? reg.scope : '');
      }).catch(function (e) {
        setSwState('실패', String((e && e.message) || e));
        // eslint-disable-next-line no-console
        console.warn('서비스워커 등록 실패(앱은 정상 동작):', e);
      });
    } catch (e) {
      setSwState('실패', String((e && e.message) || e));
      // eslint-disable-next-line no-console
      console.warn('서비스워커를 쓸 수 없는 환경(앱은 정상 동작):', e);
    }
  }
  /* 등록 결과를 **기록만** 한다 — 배너로 띄우지 않는다(사용자가 당장 할 수 있는 게 없고,
     매번 뜨면 진짜 경고를 가린다). 「앱 상태」를 펼쳤을 때만 보인다. */
  function setSwState(s, detail) {
    state.swState = s; state.swDetail = detail || '';
    if (state.currentScreen === 'home') renderDiagnostics();
  }
  function init() {
    registerServiceWorker();
    probeInstalled();   /* 「앱 상태」를 처음 펼쳤을 때 곧바로 맞는 값이 보이게 미리 물어 둔다 */
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
    state.sent = state.storage.loadSent(todayStr());
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
