/* SafetyLib — 브라우저(전역)/Node(require)/GAS(lib.gs 복사) 3환경 겸용. ES 문법은 GAS V8 지원 범위만. */
var SafetyLib = (function () {
  /* ── 시간대 고정 (계약 K1) ─────────────────────────────────────────────────
     모든 날짜 경계는 Asia/Seoul = +09:00 리터럴 오프셋으로 파싱한다.
     오프셋 없는 new Date('2026-08-04T00:00:00') 은 실행 호스트(브라우저 OS·Node TZ·
     Apps Script 프로젝트 시간대)의 앰비언트 시간대로 해석되므로, 같은 입력이 환경마다
     다른 판정을 낳는다. 이 파일 안에서는 절대 쓰지 않는다.
     (KST 는 서머타임이 없어 연중 고정 +09:00 — 오프셋 리터럴이 안전하다.) */
  var KST = '+09:00';
  var KST_OFFSET_MS = 9 * 3600000;
  function kstAt(dateStr, timeStr) { return new Date(dateStr + 'T' + timeStr + KST); }
  /* d 의 KST 벽시계 날짜(yyyy-MM-dd). getFullYear/getMonth/getDate(앰비언트) 대신
     +09:00 만큼 밀어 UTC 성분을 읽는다 → 실행 시간대와 무관하게 같은 값. */
  function kstDateStr(d) {
    var k = new Date(d.getTime() + KST_OFFSET_MS);
    return ('0000' + k.getUTCFullYear()).slice(-4) + '-' +
           ('00' + (k.getUTCMonth() + 1)).slice(-2) + '-' +
           ('00' + k.getUTCDate()).slice(-2);
  }
  function validateDate(dateStr, todayStr, pastDays, futureDays) {
    pastDays = (pastDays == null) ? 31 : pastDays;
    futureDays = (futureDays == null) ? 0 : futureDays;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || '')) return { ok: false, error: 'DATE_INVALID' };
    var d = kstAt(dateStr, '00:00:00'), t = kstAt(todayStr, '00:00:00');
    if (isNaN(d)) return { ok: false, error: 'DATE_INVALID' };
    // 비실존 날짜(2026-02-30 등)를 롤오버시키는 엔진 대비 — KST 벽시계 성분으로 되짚어 대조
    if (dateStr !== kstDateStr(d)) return { ok: false, error: 'DATE_INVALID' };
    if (d > t) {
      if ((d - t) / 86400000 > futureDays) return { ok: false, error: 'DATE_FUTURE' };
    } else if ((t - d) / 86400000 > pastDays) {
      return { ok: false, error: 'DATE_TOO_OLD' };
    }
    return { ok: true };
  }
  /* 수검자 확인 시각은 '절대시각'이어야 점검일 경계와 비교가 성립한다.
     ISO-8601 date-time 만 받고, 오프셋 표기(Z / ±HH:MM)가 없으면 KST 로 해석한다.
     엔진 임의 파싱('Aug 4 2026 10:00' 류)은 호스트 시간대로 읽혀 같은 값이 환경마다
     통과/거절이 갈리므로 형식 단계에서 잘라낸다. */
  var ACK_AT_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:\d{2})?$/;
  function parseAckMs(s) {
    if (typeof s !== 'string') return NaN;
    var m = ACK_AT_RE.exec(s);
    return m ? new Date(m[1] + 'T' + m[2] + (m[3] || KST)).getTime() : NaN;
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
    // Object.create(null): id 가 'constructor'/'toString'/'__proto__' 여도 프로토타입 오염 오판 없음
    var set = Object.create(null); (existing || []).forEach(function (id) { set[id] = 1; });
    return (expected || []).filter(function (id) { return !set[id]; });
  }
  /* 제출 ID = UUID v4 만 허용. 서버 입력 계약(멱등 키·finding_id 접두사)의 유일한 관문. */
  var SUBMISSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  function isValidSubmissionId(s) {
    return typeof s === 'string' && SUBMISSION_ID_RE.test(s);
  }
  function fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
    return ('0000000' + h.toString(16)).slice(-8);
  }
  function validateSubmission(p, masters, todayStr) {
    var errors = [], stale = false;
    if (!isValidSubmissionId(p.submission_id))
      return { ok: false, errors: [{ code: 'SUBMISSION_ID_INVALID', msg: '제출 ID 형식 오류' }], stale: false, snapshots: null };
    var insp = (masters.inspectors || []).filter(function (x) { return x.inspector_id === p.inspector_id; })[0];
    // 마스터 PIN 이 공란이면 대조할 값이 없다 → 인증 불성립(빈 PIN 우회 차단)
    if (!insp || !String(insp.pin).length || String(insp.pin) !== String(p.pin))
      return { ok: false, errors: [{ code: 'PIN_MISMATCH', msg: '점검자 PIN 불일치' }], stale: false, snapshots: null };
    if (insp.active === false) stale = true;
    var vd = validateDate(p.inspect_date, todayStr);
    if (!vd.ok) errors.push({ code: vd.error, msg: '점검일 오류' });
    var tpl = (masters.templates || []).filter(function (t) {
      return t.template_id === p.template_id && Number(t.ver) === Number(p.template_ver); })[0];
    if (!tpl) errors.push({ code: 'ITEMS_MISMATCH', msg: '템플릿/버전 없음' });
    else {
      // 개정으로 비활성이 된 (id,ver) 은 거절이 아니라 관용 수락 (설계 §7.1-5)
      if (tpl.active === false) stale = true;
      var expectIds = (tpl.items || []).filter(function (it) { return it.type === 'group' || it.type === 'item'; })
        .map(function (it) { return it.item_id; }).sort();
      if (!expectIds.length) errors.push({ code: 'MASTER_EMPTY_ITEMS', msg: '해당 버전 항목 없음' });
      else {
        var got = (p.results || []).map(function (r) { return r.i; }).sort().join(',');
        if (expectIds.join(',') !== got) errors.push({ code: 'ITEMS_MISMATCH', msg: '응답 항목 불일치' });
      }
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
    if (p.auditee_ack !== true || !(p.auditee && String(p.auditee).trim())) {
      errors.push({ code: 'ACK_REQUIRED', msg: '수검자 확인 필요' });
    } else {
      // §7.1-6 / §14-4: 서버 시각으로 덮어쓰지 않고 정합만 검증한다.
      var ackMs = parseAckMs(p.auditee_ack_at);
      if (isNaN(ackMs)) {
        errors.push({ code: 'ACK_AT_INVALID', msg: '수검자 확인 시각 오류' });
      } else if (vd.ok) {   // 점검일이 이미 틀렸으면 대조 기준이 없다(중복 보고 방지)
        // 경계는 KST 고정(계약 K1) — 앰비언트 시간대에서 파싱하면 서버 시간대가
        // Asia/Seoul 이 아닐 때 정상 제출이 통째로 ACK_AT_INVALID 로 거절된다.
        var ackLo = kstAt(p.inspect_date, '00:00:00').getTime();
        var ackHi = kstAt(todayStr, '23:59:59').getTime();
        if (isNaN(ackLo) || isNaN(ackHi) || ackMs < ackLo || ackMs > ackHi)
          errors.push({ code: 'ACK_AT_INVALID', msg: '수검자 확인 시각 오류' });
      }
    }
    if (errors.length) return { ok: false, errors: errors, stale: stale, snapshots: null };
    return { ok: true, errors: [], stale: stale, snapshots: {
      company_name: comp ? comp.name : '',
      project_name: isTmp ? String(p.project_name || '') : (proj ? proj.name : ''),
      inspector_team: insp.team, inspector_name: insp.name } };
  }
  /* 사전등록(점검계획) 검증.
     제출과 달리 '관용 수락'이 없다 — 계획은 통신이 되는 상황에서 하는 행위라
     잘못된 참조는 그 자리에서 고치게 하는 편이 데이터가 깨끗하다. */
  function validatePlan(p, masters, todayStr) {
    p = p || {};
    masters = masters || {};
    var errors = [];
    var insp = (masters.inspectors || []).filter(function (x) { return x.inspector_id === p.inspector_id; })[0];
    if (!insp || !String(insp.pin).length || String(insp.pin) !== String(p.pin))
      return { ok: false, errors: [{ code: 'PIN_MISMATCH', msg: '점검자 PIN 불일치' }], snapshots: null };
    if (!isValidSubmissionId(p.plan_id))
      return { ok: false, errors: [{ code: 'PLAN_ID_INVALID', msg: '계획 ID 형식 오류' }], snapshots: null };

    if (!validateDate(p.planned_date, todayStr, 365, 365).ok)
      errors.push({ code: 'PLAN_DATE_INVALID', msg: '점검예정일 오류(오늘 기준 ±1년)' });

    var comp = (masters.companies || []).filter(function (c) {
      return c.company_id === p.company_id && c.active !== false; })[0];
    if (!comp) errors.push({ code: 'COMPANY_UNKNOWN', msg: '협력회사 없음' });

    var hasKey = !!(p.project_key && String(p.project_key).length);
    var rawName = (p.new_project_name == null) ? '' : String(p.new_project_name).replace(/\s+/g, ' ').trim();
    var proj = null;
    if (hasKey && rawName) {
      errors.push({ code: 'PROJECT_NAME_INVALID', msg: '기존 공사와 새 공사를 동시에 지정했다' });
    } else if (hasKey) {
      proj = (masters.projects || []).filter(function (x) { return x.project_id === p.project_key; })[0];
      if (!proj) errors.push({ code: 'PROJECT_UNKNOWN', msg: '공사 없음' });
      else if (proj.company_id !== p.company_id) errors.push({ code: 'PROJECT_COMPANY_MISMATCH', msg: '타사 공사' });
    } else if (!rawName || rawName.length > 60) {
      errors.push({ code: 'PROJECT_NAME_INVALID', msg: '공사명은 1~60자' });
    }

    var tpl = (masters.templates || []).filter(function (t) {
      return t.template_id === p.template_id && Number(t.ver) === Number(p.template_ver) && t.active !== false; })[0];
    if (!tpl) errors.push({ code: 'ITEMS_MISMATCH', msg: '양식/버전 없음' });

    if (errors.length) return { ok: false, errors: errors, snapshots: null };
    return { ok: true, errors: [], snapshots: {
      company_name: comp.name,
      project_name: proj ? proj.name : rawName } };
  }
  return { validateDate: validateDate, sanitizeCell: sanitizeCell, deriveCounts: deriveCounts,
           extractFindings: extractFindings, diffIds: diffIds, fnv1a: fnv1a,
           isValidSubmissionId: isValidSubmissionId, validateSubmission: validateSubmission, validatePlan: validatePlan };
})();
if (typeof module !== 'undefined') module.exports = SafetyLib;
