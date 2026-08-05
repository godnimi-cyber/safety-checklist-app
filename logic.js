/* SafetyLogic — 브라우저(전역)/Node(require) 겸용. DOM 무의존(DOM 조작은 Task 5 app.js 담당). */
var SafetyLogic = (function () {
  var DRAFT_KEY = 'sc_draft';
  var DRAFTS_KEY = 'sc_drafts';
  var QUEUE_KEY = 'sc_queue';
  var MASTERS_KEY = 'sc_masters';
  var PLANS_KEY = 'sc_plans';

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
       최초 원본은 무슨 일이 있어도 남는다. 반환: {key, saved, full, unreadable} */
    function backupCorrupt(key, raw) {
      var base = key + CORRUPT_SUFFIX;
      for (var i = 1; i <= MAX_CORRUPT_BACKUPS; i++) {
        var bkey = (i === 1) ? base : (base + '_' + i);
        var existing = rawGet(bkey);
        /* P1: 읽기 실패 = '비었다' 가 아니라 '모른다'. 모르는 슬롯에 쓰면 실제로 있던 백업을 파괴한다(P1). */
        if (!existing.ok) return { key: bkey, saved: false, full: false, unreadable: true };
        if (existing.ok && existing.value !== null && existing.value !== undefined) continue;   /* 찬 슬롯은 덮어쓰지 않는다 */
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
       P2: 백업 실패 시 cannotWrite:true 를 반환해 호출자에게 쓰기 금지를 신호한다. */
    function loadJSON(key, fallback, validateMap) {
      var rawResult = rawGet(key);
      if (!rawResult.ok) return { ok: false, value: null };   /* 읽기 실패 */
      var raw = rawResult.value;
      if (raw === null || raw === undefined) return { ok: true, value: fallback };
      try {
        var parsed = JSON.parse(raw);
        if (validateMap && !isPlainMap(parsed)) {
          /* M3: 배열/null/문자열/숫자 → 손상으로 간주 (drafts 맵만) */
          var b = backupCorrupt(key, raw);
          api.lastError = {
            op: 'type', key: key, backup_key: b.key,
            backup_saved: b.saved, backup_full: b.full,
            message: '저장된 값이 객체가 아니다 (배열=' + Array.isArray(parsed) + ')'
          };
          /* P2: 백업이 실패했거나 꽉 찼으면, 호출자가 쓰기를 피하도록 신호 */
          if (!b.saved || b.full || b.unreadable) return { ok: true, value: fallback, cannotWrite: true };
          return { ok: true, value: fallback };
        }
        return { ok: true, value: parsed };
      } catch (e) {
        /* 손상 원본을 백업해 둔다 — 다음 save 가 덮어써도 복구 기회가 남는다 */
        var b = backupCorrupt(key, raw);
        api.lastError = {
          op: 'parse', key: key, backup_key: b.key,
          backup_saved: b.saved, backup_full: b.full, message: msgOf(e)
        };
        /* P2: 백업이 실패했거나 꽉 찼으면, 호출자가 쓰기를 피하도록 신호 */
        if (!b.saved || b.full || b.unreadable) return { ok: true, value: fallback, cannotWrite: true };
        return { ok: true, value: fallback };
      }
    }

    /* M4: UUID v4 형태와 'adhoc' 만 유효한 키다. */
    function isValidDraftKey(k) {
      if (k === 'adhoc') return true;
      if (typeof k !== 'string') return false;
      /* UUID v4: 8-4-4-4-12 hex 자리 + 버전 4 + variant 10xxxxxx */
      return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(k);
    }

    api.loadAllDrafts = function () {
      var result = loadJSON(DRAFTS_KEY, {}, true);  /* M3: 맵 검증 */
      if (!result.ok) return {};   /* 읽기 실패 → 비어 있는 것으로 간주하되 lastError 유지 */
      return result.value || {};
    };
    api.loadDraft = function (key) {
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
      if (!Object.prototype.hasOwnProperty.call(all, key)) return true;
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
      if (!oldResult.ok) return 'failed';  /* 읽기 실패 */
      var old = oldResult.value;
      if (!old) return 'none';

      var allResult = loadJSON(DRAFTS_KEY, {}, true);  /* M3: 맵 검증 */
      if (!allResult.ok) return 'failed';  /* 읽기 실패 */
      var all = allResult.value || {};

      /* M1: adhoc 충돌 감지 — P3: 수렴 여부 검사 */
      if (Object.prototype.hasOwnProperty.call(all, 'adhoc')) {
        /* P3: 값이 같으면 이미 이전이 완료된 상태 (이전 호출에서 저장만 성공하고 지우기 실패) */
        if (JSON.stringify(old) === JSON.stringify(all.adhoc)) {
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
      var result = loadJSON(QUEUE_KEY, []);
      return result.ok ? result.value : [];
    };
    /* 마스터/계획 캐시 — draft/queue 와 같은 방식(saveJSON/loadJSON, 예외 없이 false/lastError).
       app.js 가 이 래퍼를 거치지 않고 window.localStorage 를 직접 만지면 안 된다(감사 지적,
       tests-js/wiring.test.mjs §18c). 값 형태는 호출자(app.js) 자유 — 여기서는 불투명 JSON 블롭이다. */
    api.saveMasters = function (entry) { api.lastError = null; return saveJSON(MASTERS_KEY, entry); };
    api.loadMasters = function () {
      var result = loadJSON(MASTERS_KEY, null);
      return result.ok ? result.value : null;
    };
    api.savePlans = function (entry) { api.lastError = null; return saveJSON(PLANS_KEY, entry); };
    api.loadPlans = function () {
      var result = loadJSON(PLANS_KEY, null);
      return result.ok ? result.value : null;
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
