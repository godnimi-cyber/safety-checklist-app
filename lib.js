/* SafetyLib — 브라우저(전역)/Node(require)/GAS(lib.gs 복사) 3환경 겸용. ES 문법은 GAS V8 지원 범위만. */
var SafetyLib = (function () {
  function validateDate(dateStr, todayStr) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || '')) return { ok: false, error: 'DATE_INVALID' };
    var d = new Date(dateStr + 'T00:00:00'), t = new Date(todayStr + 'T00:00:00');
    if (isNaN(d)) return { ok: false, error: 'DATE_INVALID' };
    // Validate by rebuilding date string from local components to avoid timezone issues
    var reconstructed = ('0000' + d.getFullYear()).slice(-4) + '-' +
                        ('00' + (d.getMonth() + 1)).slice(-2) + '-' +
                        ('00' + d.getDate()).slice(-2);
    if (dateStr !== reconstructed) return { ok: false, error: 'DATE_INVALID' };
    if (d > t) return { ok: false, error: 'DATE_FUTURE' };
    if ((t - d) / 86400000 > 31) return { ok: false, error: 'DATE_TOO_OLD' };
    return { ok: true };
  }
  function sanitizeCell(s) {
    s = String(s == null ? '' : s);
    return /^[=+\-@]/.test(s) ? "'" + s : s;
  }
  function deriveCounts(results) {
    var c = { y: 0, n: 0, na: 0 };
    (results || []).forEach(function (r) {
      if (r.r === 'Y') c.y++; else if (r.r === 'N') c.n++; else if (r.r === 'NA') c.na++;
    });
    return c;
  }
  function extractFindings(results) {
    return (results || []).filter(function (r) { return r.r === 'N'; })
      .map(function (r) { return { item_id: r.i, note: r.n || '' }; });
  }
  function diffIds(expected, existing) {
    var set = {}; (existing || []).forEach(function (id) { set[id] = 1; });
    return (expected || []).filter(function (id) { return !set[id]; });
  }
  function fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
    return ('0000000' + h.toString(16)).slice(-8);
  }
  function validateSubmission(p, masters, todayStr) {
    var errors = [], stale = false;
    var insp = (masters.inspectors || []).filter(function (x) { return x.inspector_id === p.inspector_id; })[0];
    if (!insp || String(insp.pin) !== String(p.pin))
      return { ok: false, errors: [{ code: 'PIN_MISMATCH', msg: '점검자 PIN 불일치' }], stale: false, snapshots: null };
    if (insp.active === false) stale = true;
    var vd = validateDate(p.inspect_date, todayStr);
    if (!vd.ok) errors.push({ code: vd.error, msg: '점검일 오류' });
    var tpl = (masters.templates || []).filter(function (t) {
      return t.template_id === p.template_id && Number(t.ver) === Number(p.template_ver); })[0];
    if (!tpl) errors.push({ code: 'ITEMS_MISMATCH', msg: '템플릿/버전 없음' });
    else {
      var expect = tpl.items.filter(function (it) { return it.type === 'group' || it.type === 'item'; })
        .map(function (it) { return it.item_id; }).sort().join(',');
      var got = (p.results || []).map(function (r) { return r.i; }).sort().join(',');
      if (expect !== got) errors.push({ code: 'ITEMS_MISMATCH', msg: '응답 항목 불일치' });
    }
    (p.results || []).forEach(function (r) {
      if (r.r !== 'Y' && r.r !== 'N' && r.r !== 'NA') errors.push({ code: 'RESULT_INVALID', msg: r.i + ' 응답값 오류' });
      if (r.r === 'N' && !(r.n && String(r.n).trim())) errors.push({ code: 'NOTE_REQUIRED', msg: r.i + ' 내용 필수' });
      if (r.n && String(r.n).length > 300) errors.push({ code: 'NOTE_TOO_LONG', msg: r.i + ' 내용 300자 초과' });
    });
    var comp = (masters.companies || []).filter(function (c) { return c.company_id === p.company_id; })[0];
    var isTmp = /^TMP-/.test(p.project_key || '');
    var proj = null;
    if (!comp) errors.push({ code: 'COMPANY_UNKNOWN', msg: '협력회사 없음' });
    else if (comp.active === false) stale = true;
    if (!isTmp) {
      proj = (masters.projects || []).filter(function (x) { return x.project_id === p.project_key; })[0];
      if (!proj) errors.push({ code: 'PROJECT_UNKNOWN', msg: '공사 없음' });
      else {
        if (proj.company_id !== p.company_id) errors.push({ code: 'PROJECT_COMPANY_MISMATCH', msg: '타사 공사' });
        if (proj.status && proj.status !== '진행') stale = true;
      }
    }
    if (p.auditee_ack !== true || !(p.auditee && String(p.auditee).trim()))
      errors.push({ code: 'ACK_REQUIRED', msg: '수검자 확인 필요' });
    if (errors.length) return { ok: false, errors: errors, stale: stale, snapshots: null };
    return { ok: true, errors: [], stale: stale, snapshots: {
      company_name: comp ? comp.name : '',
      project_name: isTmp ? String(p.project_name || '') : (proj ? proj.name : ''),
      inspector_team: insp.team, inspector_name: insp.name } };
  }
  return { validateDate: validateDate, sanitizeCell: sanitizeCell, deriveCounts: deriveCounts,
           extractFindings: extractFindings, diffIds: diffIds, fnv1a: fnv1a,
           validateSubmission: validateSubmission };
})();
if (typeof module !== 'undefined') module.exports = SafetyLib;
