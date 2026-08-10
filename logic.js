/* SafetyLogic — 브라우저(전역)/Node(require) 겸용. DOM 무의존(DOM 조작은 Task 5 app.js 담당). */
var SafetyLogic = (function () {
  var DRAFT_KEY = 'sc_draft';
  var DRAFTS_KEY = 'sc_drafts';
  var QUEUE_KEY = 'sc_queue';
  var MASTERS_KEY = 'sc_masters';
  var PLANS_KEY = 'sc_plans';
  var SENT_KEY = 'sc_sent';   /* 오늘 보낸 점검 영수증(당일분만 보관) */
  var RECENT_EMAIL_KEY = 'sc_recent_email';   /* 점검자별 최근 발송 주소 — { <inspector_id>: [addr,...] } 맵 */

  function hasWebCrypto() {
    return typeof globalThis !== 'undefined' && !!globalThis.crypto;
  }

  function uuid() {
    if (hasWebCrypto() && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
    if (!hasWebCrypto() || typeof globalThis.crypto.getRandomValues !== 'function') {
      throw new Error('CRYPTO_UNAVAILABLE');
    }
    var b = globalThis.crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // variant RFC4122 (10xxxxxx)
    var hex = [];
    for (var i = 0; i < b.length; i++) hex.push(('0' + b[i].toString(16)).slice(-2));
    return hex.slice(0, 4).join('') + '-' + hex.slice(4, 6).join('') + '-' +
      hex.slice(6, 8).join('') + '-' + hex.slice(8, 10).join('') + '-' +
      hex.slice(10, 16).join('');
  }

  function newDraft(templateId, ver, todayStr) {
    return {
      submission_id: uuid(),
      inspect_date: todayStr,
      template_id: templateId,
      template_ver: ver,
      results: {},
      company_id: '',
      project_key: '',
      project_name: '',
      inspector_id: '',
      pin: '',
      auditee: '',
      auditee_ack: false,
      auditee_ack_at: ''
    };
  }

  function draftToPayload(draft, config, mastersRev) {
    var ids = Object.keys(draft.results).sort();
    var results = ids.map(function (id) {
      var entry = draft.results[id] || {};
      var row = { i: id, r: entry.r };
      if (entry.n) row.n = entry.n;
      return row;
    });
    return {
      submission_id: draft.submission_id,
      inspect_date: draft.inspect_date,
      template_id: draft.template_id,
      template_ver: draft.template_ver,
      company_id: draft.company_id,
      project_key: draft.project_key,
      project_name: draft.project_name,
      inspector_id: draft.inspector_id,
      pin: draft.pin,
      auditee: draft.auditee,
      auditee_ack: draft.auditee_ack,
      auditee_ack_at: draft.auditee_ack_at,
      results: results,
      masters_rev: mastersRev,
      app_ver: config.APP_VER
    };
  }

  function progress(draft, templateItems) {
    var total = 0, answered = 0;
    (templateItems || []).forEach(function (it) {
      if (it.type === 'group' || it.type === 'item') {
        total++;
        if (draft.results && Object.prototype.hasOwnProperty.call(draft.results, it.item_id)) answered++;
      }
    });
    return { answered: answered, total: total };
  }

  /* R3: 키 순서에 흔들리지 않는 결정적 직렬화.
     JSON.stringify 는 객체 키를 '삽입 순서'대로 쓴다 — 구조가 완전히 같은 두 객체도 키가 들어간
     순서가 다르면 다른 문자열이 된다. 그 비교로 이전(migration) 충돌을 판정하면 실제로는 같은
     값인데 영원히 'collision' 이 나와 수렴하지 않는다.
     입력은 항상 JSON.parse 의 결과이므로 순환 참조·undefined·함수가 없다 → 재귀 키 정렬로 충분하다.
     외부 라이브러리 없이 ES5 로 구현한다. */
  function stableStringify(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    var i;
    if (Object.prototype.toString.call(v) === '[object Array]') {
      var items = [];
      for (i = 0; i < v.length; i++) {
        var el = stableStringify(v[i]);
        items.push(el === undefined ? 'null' : el);   /* JSON.stringify 의 배열 구멍 규칙과 동일 */
      }
      return '[' + items.join(',') + ']';
    }
    var keys = Object.keys(v).sort();
    var parts = [];
    for (i = 0; i < keys.length; i++) {
      var enc = stableStringify(v[keys[i]]);
      if (enc === undefined) continue;   /* undefined 프로퍼티는 JSON.stringify 처럼 생략 */
      parts.push(JSON.stringify(keys[i]) + ':' + enc);
    }
    return '{' + parts.join(',') + '}';
  }

  function queueReducer(queue, event) {
    queue = queue || [];
    if (!event) return queue;
    if (event.type === 'ENQUEUE') {
      var added = {};
      Object.keys(event.item).forEach(function (k) { added[k] = event.item[k]; });
      added.state = 'pending';
      return queue.concat([added]);
    }
    if (event.type === 'FAILED') {
      return queue.map(function (q) {
        if (q.submission_id !== event.id) return q;
        var updated = {};
        Object.keys(q).forEach(function (k) { updated[k] = q[k]; });
        updated.state = 'failed';
        updated.reason = event.reason;
        return updated;
      });
    }
    if (event.type === 'SENT') {
      return queue.filter(function (q) { return q.submission_id !== event.id; });
    }
    return queue;
  }

  /* storage(win)
     - 어떤 경로에서도 예외를 던지지 않는다. localStorage 접근 자체가 SecurityError 를 던지는
       환경(iOS Safari '모든 쿠키 차단')에서도 앱이 죽지 않고 세션 한정 메모리 저장으로 동작한다.
     - available: 진짜 localStorage 를 쓰는지 여부(false 면 새로고침 시 소실됨을 호출자가 고지해야 한다).
     - save 계열 반환값: 성공 true / 실패 false (실패해도 던지지 않는다).
     - lastError: 직전 호출의 실패 정보({op, key, message, ...}) — 성공한 호출은 null 로 초기화한다.
       JSON 파싱 실패 시 op:'parse' + 손상 원본을 '<key>_corrupt_backup' 에 백업(backup_saved 로 결과 표시).
       백업 슬롯은 '<key>_corrupt_backup', '..._2', '..._3' 최대 3개이며 **이미 찬 슬롯은 절대 덮어쓰지
       않는다**(2차 손상이 최초 원본을 지우면 복구가 불가능해진다). 3개가 모두 차면 새 손상본은 버리고
       backup_saved:false + backup_full:true 로 알린다. */
  function storage(win) {
    var CORRUPT_SUFFIX = '_corrupt_backup';
    var MAX_CORRUPT_BACKUPS = 3;
    var mem = {};   /* localStorage 를 못 쓸 때의 세션 한정 폴백 저장소 */
    var ls = null;
    try {
      ls = (win && win.localStorage) || null;
      if (ls) ls.getItem(DRAFT_KEY);   /* 접근/읽기 자체가 던지는 환경을 여기서 탐지 */
    } catch (e) {
      ls = null;
    }
    var api = { available: !!ls, lastError: null };

    function msgOf(e) { return (e && e.message) ? e.message : String(e); }
    function fail(op, key, e) {
      api.lastError = { op: op, key: key, message: msgOf(e) };
      return false;
    }
    /* mem 은 '영속되지 못한 값'의 오버레이다 — 있으면 항상 우선한다.
       실제 저장이 성공하면 오버레이를 지워 낡은 값이 남지 않게 한다.
       M2: 실패와 '값 없음'을 구별하기 위해 { ok, value } 를 반환한다. */
    function rawGet(key) {
      if (Object.prototype.hasOwnProperty.call(mem, key)) return { ok: true, value: mem[key] };
      if (ls) {
        try { return { ok: true, value: ls.getItem(key) }; }
        catch (e) { fail('get', key, e); return { ok: false, value: null }; }
      }
      return { ok: true, value: null };
    }
    /* 이 키의 현재 값이 '영속되지 못한 오버레이'인가.
       실 localStorage 가 있는데도 mem 에 값이 있다 = setItem 이 실패해 세션 한정으로만 남은 값이다.
       (ls 가 없는 폴백 모드에서는 mem 이 곧 저장소이므로 volatile 이 아니다 — 소실 위험은
       available:false 로 이미 고지된다.) */
    function isVolatile(key) {
      return !!ls && Object.prototype.hasOwnProperty.call(mem, key);
    }
    function rawSet(key, str) {
      if (ls) {
        try { ls.setItem(key, str); delete mem[key]; return true; }
        catch (e) { mem[key] = str; return fail('set', key, e); }   /* 세션 한정으로라도 보존 */
      }
      mem[key] = str;
      return true;   /* 폴백 저장소는 정상 동작 — 소실 위험은 available:false 로 이미 고지됨 */
    }
    /* 삭제는 '실제로 지워진 곳'만 지운다.
       폴백 모드(ls 없음)에서는 mem 이 곧 저장소이므로 mem 을 지우는 것이 삭제 그 자체다.
       실 localStorage 모드에서 removeItem 이 실패하면 오버레이도 남긴다 — 여기서 mem 만 지우면
       다음 읽기가 ls 에 남은 (오버레이보다 낡은) 값을 되살려 상태가 갈라진다.
       M1-b: 반환값으로 성공/실패를 알린다(fail 함수가 lastError 를 설정하고 false 를 반환함). */
    function rawRemove(key) {
      if (!ls) { delete mem[key]; return true; }
      try { ls.removeItem(key); } catch (e) { return fail('remove', key, e); }
      delete mem[key];
      return true;
    }
    function saveJSON(key, value) {
      var str;
      try { str = JSON.stringify(value); } catch (e) { return fail('stringify', key, e); }
      return rawSet(key, str);
    }
    /* 손상 원본을 빈 백업 슬롯에 넣는다. 이미 값이 있는 슬롯은 건드리지 않으므로
       최초 원본은 무슨 일이 있어도 남는다.
       R2: 같은 손상본은 슬롯을 더 먹지 않는다. 손상된 키는 고쳐지기 전까지 '읽을 때마다' 손상으로
       감지되므로(앱 기동마다 1회 이상), 중복 감지가 없으면 정상 사용만으로 3~4회 만에 슬롯 3개가
       모두 같은 원본으로 차고 그 뒤 모든 쓰기가 막힌다. 이미 같은 raw 가 들어 있는 슬롯을 찾으면
       '이미 백업됨'(saved:true, deduped:true)으로 보고 새 슬롯을 쓰지 않는다 — 원본은 이미 안전하다.
       반환: {key, saved, full, unreadable, deduped} */
    function backupCorrupt(key, raw) {
      var base = key + CORRUPT_SUFFIX;
      for (var i = 1; i <= MAX_CORRUPT_BACKUPS; i++) {
        var bkey = (i === 1) ? base : (base + '_' + i);
        var existing = rawGet(bkey);
        /* P1: 읽기 실패 = '비었다' 가 아니라 '모른다'. 모르는 슬롯에 쓰면 실제로 있던 백업을 파괴한다(P1). */
        if (!existing.ok) return { key: bkey, saved: false, full: false, unreadable: true };
        if (existing.value !== null && existing.value !== undefined) {
          if (existing.value === raw) {
            /* R2: 바로 이 원본이 이미 여기 보관돼 있다 → 새 슬롯을 소비하지 않는다.
               단 그 값이 영속되지 못한 오버레이라면 아직 '백업됐다'고 말할 수 없다(새로고침이면
               사라진다) → 같은 슬롯에 다시 쓰기를 시도하고, 또 실패하면 정직하게 saved:false.
               그래야 P2 의 쓰기 금지(cannotWrite)가 계속 작동한다. */
            if (!isVolatile(bkey)) return { key: bkey, saved: true, full: false, deduped: true };
            var again = false;
            try { again = rawSet(bkey, raw); } catch (e3) { again = fail('backup', bkey, e3); }
            return { key: bkey, saved: again, full: false, deduped: true };
          }
          continue;   /* 다른 값이 든 슬롯은 덮어쓰지 않는다 */
        }
        var saved = false;
        try { saved = rawSet(bkey, raw); } catch (e2) { saved = fail('backup', bkey, e2); }
        return { key: bkey, saved: saved, full: false };
      }
      /* 슬롯 소진 — 새 손상본을 버릴지언정 기존 백업을 밀어내지 않는다 */
      return { key: base, saved: false, full: true };
    }
    /* M3: 저장된 값이 배열·null·문자열이면 손상으로 간주한다 (순수 객체만 맵이다). */
    function isPlainMap(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

    /* M2: 읽기 결과와 읽기 실패를 구분한다. 읽기가 실패하면 { ok: false } 를 반환.
       호출자는 ok === false 일 때 쓰기를 중단하고 false/lastError 를 반환해야 한다.
       validateMap 은 M3을 위해 drafts 맵만 검증(queue/masters/plans는 배열/임의 형태 허용).
       P2: 백업 실패 시 cannotWrite:true 를 반환해 호출자에게 쓰기 금지를 신호한다.
       F4: volatile:true 는 '지금 읽은 이 값이 영속되지 못한 세션 오버레이'라는 뜻이다.
       rawGet 은 mem 오버레이를 우선하므로, 영속 저장이 실패한 직후의 읽기는 '저장이 된 것처럼'
       보인다 — 그 착시 위에서 원본을 지우거나 성공을 보고하면 새로고침 때 기록이 사라진다.
       (백업 슬롯에는 R2 에서 이미 같은 판정을 넣었다. 주 저장 맵에도 같은 함정이 있다.) */
    function loadJSON(key, fallback, validateMap) {
      var rawResult = rawGet(key);
      if (!rawResult.ok) return { ok: false, value: null };   /* 읽기 실패 */
      var vol = isVolatile(key);
      var raw = rawResult.value;
      if (raw === null || raw === undefined) return { ok: true, value: fallback, volatile: vol };
      try {
        var parsed = JSON.parse(raw);
        if (validateMap && !isPlainMap(parsed)) {
          /* M3: 배열/null/문자열/숫자 → 손상으로 간주 (drafts 맵만) */
          var b = backupCorrupt(key, raw);
          api.lastError = {
            op: 'type', key: key, backup_key: b.key,
            backup_saved: b.saved, backup_full: !!b.full,
            /* R4: '읽을 수 없었다'(슬롯 상태를 모른다)와 '쓰기가 실패했다'는 서로 다른 사건이다.
               둘 다 backup_saved:false 라 이 필드가 없으면 호출자가 구별할 수 없다. */
            backup_unreadable: !!b.unreadable, backup_deduped: !!b.deduped,
            message: '저장된 값이 객체가 아니다 (배열=' + Array.isArray(parsed) + ')'
          };
          /* P2: 백업이 실패했거나 꽉 찼으면, 호출자가 쓰기를 피하도록 신호
             R1: corrupt 는 '값을 잃고 fallback 으로 대체했다'는 사실 자체 — 백업이 성공해도 남는다.
             (fallback 을 '원래 비어 있었다'로 착각하면 안 되는 호출자가 본다) */
          if (!b.saved || b.full || b.unreadable) {
            return { ok: true, value: fallback, cannotWrite: true, corrupt: true, volatile: vol };
          }
          return { ok: true, value: fallback, corrupt: true, volatile: vol };
        }
        return { ok: true, value: parsed, volatile: vol };
      } catch (e) {
        /* 손상 원본을 백업해 둔다 — 다음 save 가 덮어써도 복구 기회가 남는다 */
        var b = backupCorrupt(key, raw);
        api.lastError = {
          op: 'parse', key: key, backup_key: b.key,
          backup_saved: b.saved, backup_full: !!b.full,
          backup_unreadable: !!b.unreadable, backup_deduped: !!b.deduped,
          message: msgOf(e)
        };
        /* P2: 백업이 실패했거나 꽉 찼으면, 호출자가 쓰기를 피하도록 신호 */
        if (!b.saved || b.full || b.unreadable) {
          return { ok: true, value: fallback, cannotWrite: true, corrupt: true, volatile: vol };
        }
        return { ok: true, value: fallback, corrupt: true, volatile: vol };
      }
    }

    /* M4: UUID v4 형태와 'adhoc' 만 유효한 키다. */
    function isValidDraftKey(k) {
      if (k === 'adhoc') return true;
      if (typeof k !== 'string') return false;
      /* UUID v4: 8-4-4-4-12 hex 자리 + 버전 4 + variant 10xxxxxx */
      return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(k);
    }

    /* R4: 공개 읽기 함수는 진입 시 lastError 를 지운다 — 이 호출에서 실제로 생긴 오류만 남는다.
       (앞서 거절된 키가 남긴 오류가 성공한 읽기 뒤에도 살아 있으면 호출자가 '지금 실패했다'고 오인한다.)
       쓰기 함수(saveDraft/clearDraft)는 loadJSON '전에' 지운다 — 그 호출 안에서 생긴 손상/읽기실패
       오류는 반드시 보존되어야 하기 때문이다. 그 순서를 여기 맞춰 바꾸면 안 된다. */
    api.loadAllDrafts = function () {
      api.lastError = null;
      var result = loadJSON(DRAFTS_KEY, {}, true);  /* M3: 맵 검증 */
      if (!result.ok) return {};   /* 읽기 실패 → 비어 있는 것으로 간주하되 lastError 유지 */
      return result.value || {};
    };
    api.loadDraft = function (key) {
      api.lastError = null;
      var result = loadJSON(DRAFTS_KEY, {}, true);  /* M3: 맵 검증 */
      if (!result.ok) return null;   /* 읽기 실패 → null, lastError 유지 */
      var all = result.value || {};
      return Object.prototype.hasOwnProperty.call(all, key) ? all[key] : null;
    };
    api.saveDraft = function (key, draft) {
      /* M4: 키 검증 */
      if (!isValidDraftKey(key)) {
        api.lastError = { op: 'key', key: key, message: '키는 adhoc 또는 UUID v4 형식이어야 한다' };
        return false;
      }
      /* P4: 읽기 중 발생한 P1·P2 오류(손상/읽기실패)를 보존하되 직전 호출의 낡은 오류는 지운다 */
      api.lastError = null;
      var result = loadJSON(DRAFTS_KEY, {}, true);  /* M3: 맵 검증 */
      if (!result.ok) { /* 읽기 실패 → 아무 것도 쓰지 않는다(M2) */
        /* lastError 는 이미 loadJSON 에서 설정됨 */
        return false;
      }
      /* P2: 백업이 실패했으면 쓰기를 중단한다 */
      if (result.cannotWrite) {
        /* lastError 는 이미 loadJSON 에서 설정됨 */
        return false;
      }
      var all = result.value || {};
      all[key] = draft;
      return saveJSON(DRAFTS_KEY, all);
    };
    api.clearDraft = function (key) {
      /* M4: 키 검증 */
      if (!isValidDraftKey(key)) {
        api.lastError = { op: 'key', key: key, message: '키는 adhoc 또는 UUID v4 형식이어야 한다' };
        return false;
      }
      /* P4: 읽기 중 발생한 P1·P2 오류(손상/읽기실패)를 보존하되 직전 호출의 낡은 오류는 지운다 */
      api.lastError = null;
      var result = loadJSON(DRAFTS_KEY, {}, true);  /* M3: 맵 검증 */
      if (!result.ok) { /* 읽기 실패 → 아무 것도 쓰지 않는다(M2) */
        /* lastError 는 이미 loadJSON 에서 설정됨 */
        return false;
      }
      /* P2: 백업이 실패했으면 쓰기를 중단한다 */
      if (result.cannotWrite) {
        /* lastError 는 이미 loadJSON 에서 설정됨 */
        return false;
      }
      var all = result.value || {};
      if (!Object.prototype.hasOwnProperty.call(all, key)) {
        /* F4: '맵에 없다'는 것도, 그 맵 자체가 영속되지 못한 오버레이라면 영속된 사실이 아니다.
           앞선 삭제의 저장이 실패해 {} 오버레이만 남은 상태에서 그냥 true 를 돌려주면,
           영속 저장소에는 draft 가 그대로 있는데 사용자에게 "지웠다"고 거짓 보고하게 된다.
           현재 맵의 영속 재시도 결과를 그대로 반환한다. */
        if (result.volatile) return saveJSON(DRAFTS_KEY, all);
        return true;
      }
      delete all[key];
      return saveJSON(DRAFTS_KEY, all);
    };
    /* 옛 단일 슬롯(sc_draft) → sc_drafts['adhoc'].
       M1: 충돌 감지 및 처리 — adhoc 이 이미 있으면 옮기지도 지우지도 않는다.
       M1-b: 저장은 성공했지만 지우기가 실패하면 'copied' 를 반환 — 두 벌이 남아 있음을 알린다.
       P3: adhoc 이 이미 있더라도 값이 같으면 수렴(converged)으로 간주, 지우기만 재시도한다.
       저장이 실패하면 옛 키를 지우지 않는다 — 옮기기 전에 원본을 잃으면 복구할 수 없다. */
    api.migrateLegacyDraft = function () {
      api.lastError = null;
      var oldResult = loadJSON(DRAFT_KEY, null, true);  /* M3: 맵 검증 */
      /* R1: 읽기 실패는 물론, 백업 불가(cannotWrite)와 '손상되어 fallback 으로 대체됨'(corrupt)도
         실패다. corrupt 인데 'none' 을 돌려주면 "옮길 게 없었다"는 거짓말이 된다 — 실제로는 옛
         기록이 있었고 읽지 못했을 뿐이며, 앱은 아무 것도 고지하지 않고 넘어간다. */
      if (!oldResult.ok || oldResult.cannotWrite || oldResult.corrupt) return 'failed';
      var old = oldResult.value;
      if (!old) return 'none';   /* 정상적으로 '값 없음'을 읽은 경우만 여기 온다 */

      var allResult = loadJSON(DRAFTS_KEY, {}, true);  /* M3: 맵 검증 */
      /* R1: cannotWrite(백업 실패·슬롯 소진·슬롯 읽기 불가)면 아무 것도 쓰지 않는다.
         여기서 그냥 진행하면 손상된 sc_drafts 를 백업 없이 {} 로 덮어쓰고 sc_draft 까지 지운다
         — 손상 원본이 흔적 없이 소멸한다(스펙 §6·계약 K4 위반).
         corrupt 자체는 막지 않는다: 백업이 성공했다면 손상 복구를 계속 진행해야 한다(그렇지 않으면
         손상을 한 번 만난 사용자가 그 뒤로 영원히 이전을 못 한다). */
      if (!allResult.ok || allResult.cannotWrite) return 'failed';
      var all = allResult.value || {};

      /* M1: adhoc 충돌 감지 — P3: 수렴 여부 검사 */
      if (Object.prototype.hasOwnProperty.call(all, 'adhoc')) {
        /* P3: 값이 같으면 이미 이전이 완료된 상태 (이전 호출에서 저장만 성공하고 지우기 실패)
           R3: 키 순서에 흔들리지 않는 결정적 직렬화로 비교한다 — 'collision' 은 값이 진짜 다를 때만. */
        if (stableStringify(old) === stableStringify(all.adhoc)) {
          /* F4: '값이 같다'가 곧 '이전이 끝났다'는 아니다. 앞선 호출의 saveJSON 이 실패했다면
             그 사본은 mem 오버레이에만 있고(rawGet 이 오버레이를 우선하므로 저장된 것처럼 보인다)
             영속 저장소에는 없다. 그 상태에서 옛 키를 지우면 새로고침 순간 오버레이도 함께
             사라져 점검 기록이 통째로 없어진다 — 영속 재시도가 성공했을 때만 지운다.
             (ls 가 없는 폴백 모드는 mem 이 곧 저장소라 volatile 이 아니다 → 여기 걸리지 않는다.) */
          if (allResult.volatile && !saveJSON(DRAFTS_KEY, all)) return 'failed';
          /* 지우기만 재시도 */
          if (!rawRemove(DRAFT_KEY)) return 'copied';
          return 'migrated';
        }
        /* P3: 값이 다르면 실제 충돌 */
        api.lastError = {
          op: 'migrate', key: DRAFT_KEY,
          message: 'adhoc 슬롯 충돌 — 옛 임시저장을 보존했다'
        };
        return 'collision';
      }

      all.adhoc = old;
      if (!saveJSON(DRAFTS_KEY, all)) return 'failed';

      /* M1-b: 지우기 실패 처리 */
      if (!rawRemove(DRAFT_KEY)) return 'copied';  /* 사본은 만들었으나 옛 키가 남았다 */
      return 'migrated';
    };
    api.saveQueue = function (queue) { api.lastError = null; return saveJSON(QUEUE_KEY, queue); };
    api.loadQueue = function () {
      api.lastError = null;   /* R4 */
      var result = loadJSON(QUEUE_KEY, []);
      return result.ok ? result.value : [];
    };
    /* 마스터/계획 캐시 — draft/queue 와 같은 방식(saveJSON/loadJSON, 예외 없이 false/lastError).
       app.js 가 이 래퍼를 거치지 않고 window.localStorage 를 직접 만지면 안 된다(감사 지적,
       tests-js/wiring.test.mjs §18c). 값 형태는 호출자(app.js) 자유 — 여기서는 불투명 JSON 블롭이다. */
    api.saveMasters = function (entry) { api.lastError = null; return saveJSON(MASTERS_KEY, entry); };
    api.loadMasters = function () {
      api.lastError = null;   /* R4 */
      var result = loadJSON(MASTERS_KEY, null);
      return result.ok ? result.value : null;
    };
    /* 오늘 보낸 점검 — **당일분만** 보관한다. 날짜가 바뀌면 스스로 비워져 무한히 쌓이지 않는다.
       저장소는 유한하고(할당량 초과가 이 앱의 실제 실패 모드다) 이 목록의 쓰임새도 당일뿐이다.
       걸러내는 일을 저장·조회 양쪽에서 한다: 저장만 거르면 자정을 넘긴 뒤 처음 열었을 때
       어제 것이 그대로 보이고, 조회만 거르면 지운 적이 없어 용량이 계속 는다. */
    function pruneSent_(list, todayStr) {
      return (list || []).filter(function (r) { return r && String(r.sent_date) === String(todayStr); });
    }
    api.saveSent = function (list, todayStr) {
      api.lastError = null;
      return saveJSON(SENT_KEY, pruneSent_(list, todayStr));
    };
    api.loadSent = function (todayStr) {
      api.lastError = null;
      var result = loadJSON(SENT_KEY, []);
      return pruneSent_(result.ok ? result.value : [], todayStr);
    };
    api.savePlans = function (entry) { api.lastError = null; return saveJSON(PLANS_KEY, entry); };
    api.loadPlans = function () {
      api.lastError = null;   /* R4 */
      var result = loadJSON(PLANS_KEY, null);
      return result.ok ? result.value : null;
    };
    /* 점검자별 최근 발송 주소(설계 rev.7 §7-3) — drafts(DRAFTS_KEY)와 같은 방식(한 키 아래 맵)이다.
       **점검자마다 별도 localStorage 키를 만들지 않는다**: 공용 폰에서 다음 사용자가 앞사람 주소를
       고르는 사고를 막으려면 점검자별로 갈라야 하지만, 그렇다고 app.js 가 이 래퍼를 거치지 않고
       window.localStorage 를 직접 만지면 안 된다(감사 지적, tests-js/wiring.test.mjs §18c).
       값 검증은 여기서 최소한만 한다 — 맵이 아니면 손상(M3), 그 안의 항목이 배열이 아니면 빈 목록.
       문자열을 목록으로 착각하면 호출자의 filter/slice 가 글자 하나하나를 주소로 그린다. */
    api.loadRecentEmails = function (inspectorId) {
      api.lastError = null;   /* R4 */
      var result = loadJSON(RECENT_EMAIL_KEY, {}, true);   /* M3: 맵 검증 */
      if (!result.ok) return [];
      var list = (result.value || {})[String(inspectorId || '-')];
      return (Object.prototype.toString.call(list) === '[object Array]') ? list : [];
    };
    api.saveRecentEmails = function (inspectorId, list) {
      /* P4: 읽기 중 발생한 P1·P2 오류는 보존하되 직전 호출의 낡은 오류는 지운다 */
      api.lastError = null;
      var result = loadJSON(RECENT_EMAIL_KEY, {}, true);   /* M3: 맵 검증 */
      if (!result.ok || result.cannotWrite) return false;   /* lastError 는 이미 loadJSON 이 채웠다 */
      var all = result.value || {};
      all[String(inspectorId || '-')] = list;
      return saveJSON(RECENT_EMAIL_KEY, all);
    };
    api.clearRecentEmails = function (inspectorId) {
      api.lastError = null;
      var result = loadJSON(RECENT_EMAIL_KEY, {}, true);
      if (!result.ok || result.cannotWrite) return false;
      var all = result.value || {};
      var k = String(inspectorId || '-');
      if (!Object.prototype.hasOwnProperty.call(all, k)) {
        /* F4: 맵 자체가 영속되지 못한 오버레이일 수 있다 — clearDraft 와 같은 판단 */
        if (result.volatile) return saveJSON(RECENT_EMAIL_KEY, all);
        return true;
      }
      delete all[k];
      return saveJSON(RECENT_EMAIL_KEY, all);
    };
    return api;
  }

  return {
    newDraft: newDraft,
    draftToPayload: draftToPayload,
    uuid: uuid,
    progress: progress,
    queueReducer: queueReducer,
    storage: storage
  };
})();
if (typeof module !== 'undefined') module.exports = SafetyLogic;
