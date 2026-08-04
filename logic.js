/* SafetyLogic — 브라우저(전역)/Node(require) 겸용. DOM 무의존(DOM 조작은 Task 5 app.js 담당). */
var SafetyLogic = (function () {
  var DRAFT_KEY = 'sc_draft';
  var QUEUE_KEY = 'sc_queue';

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

  function storage(win) {
    var ls = win.localStorage;
    function loadJSON(key, fallback) {
      var raw = ls.getItem(key);
      if (raw === null || raw === undefined) return fallback;
      try {
        return JSON.parse(raw);
      } catch (e) {
        return fallback;
      }
    }
    return {
      saveDraft: function (draft) { ls.setItem(DRAFT_KEY, JSON.stringify(draft)); },
      loadDraft: function () { return loadJSON(DRAFT_KEY, null); },
      clearDraft: function () { ls.removeItem(DRAFT_KEY); },
      saveQueue: function (queue) { ls.setItem(QUEUE_KEY, JSON.stringify(queue)); },
      loadQueue: function () { return loadJSON(QUEUE_KEY, []); }
    };
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
