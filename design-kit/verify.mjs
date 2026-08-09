#!/usr/bin/env node
// verify.mjs — 디자인 킷 계약 검사기(의존성 0). 킷과 함께 배포된다.
// 사용법: node verify.mjs [검사할_디렉토리]   (기본: 현재 디렉토리)
// 종료코드: 0 = 위반 없음(경고는 허용), 1 = error 위반 존재, 2 = 사용법/설정 오류
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// 킷 자체 무결성 — kit-manifest.json의 outputs 해시와 실제 파일을 비교한다.
// "수동 편집 금지"가 문서로만 있으면 지켜지지 않는다. 편집된 킷은 다음 내보내기에서
// 조용히 덮여 사라지므로, 편집을 발견하는 시점이 이를수록 손실이 작다.
// 규칙 로딩보다 **먼저** 한다 — rules.json을 지우면 이 검사에 닿기도 전에 종료코드 2로
// 끝나서 킷 훼손이 보고되지 않았다(적대 리뷰 적발).
const kitDrift = [];
try {
  const man = JSON.parse(fs.readFileSync(path.join(HERE, 'kit-manifest.json'), 'utf8'));
  for (const [name, want] of Object.entries(man.outputs ?? {})) {
    // manifest는 편집될 수 있는 파일이다 — 여기 적힌 이름으로 킷 밖을 가리키지 못하게 한다
    if (name !== path.basename(name) || name === '.' || name === '..') {
      kitDrift.push(name + ' — kit-manifest.json의 outputs에 경로가 섞였습니다');
      continue;
    }
    const p = path.join(HERE, name);
    if (!fs.existsSync(p)) { kitDrift.push(name + ' — 파일이 없습니다'); continue; }
    // 개행 정규화 후 해시 — Windows 체크아웃(core.autocrlf)에서 전부 "수정됨"이 되는 것을 막는다
    const got = crypto.createHash('sha256').update(fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n')).digest('hex');
    if (got !== want) kitDrift.push(name + ' — 내보낸 뒤 수정됐습니다(다음 내보내기에서 사라집니다)');
  }
} catch (e) {
  kitDrift.push('kit-manifest.json을 읽을 수 없습니다: ' + e.message);
}

let rules;
try {
  rules = JSON.parse(fs.readFileSync(path.join(HERE, 'rules.json'), 'utf8'));
} catch (e) {
  for (const d of kitDrift) console.log('ERROR [kit-modified] ' + d);
  console.error('rules.json을 읽을 수 없습니다: ' + e.message);
  process.exit(kitDrift.length ? 1 : 2);
}

const target = path.resolve(process.argv[2] ?? '.');
if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
  // 종료코드 계약(2 = 사용법/설정 오류)을 지킨다 — 예외를 그대로 터뜨리면 node 기본값 1이 되고,
  // 소비 측 CI는 1을 "킷 계약 위반"으로 읽는다.
  console.error('검사할 디렉토리가 없습니다: ' + target);
  process.exit(2);
}
const ignoreDirs = new Set(rules.ignoreDirs);
const ignoreFiles = new Set(rules.ignoreFiles);
const exts = new Set(rules.scanExtensions);

// 제외 대상은 "킷 자신의 산출물"이다 — 파일 이름만 보면 소비 프로젝트의 동명 파일
// (자기 tokens.css·components.css)까지 통째로 그림자에 들어간다. 킷 디렉토리 안일 때만 제외한다.
const isKitOwnFile = (full, name) => ignoreFiles.has(name) && path.resolve(path.dirname(full)) === path.resolve(HERE);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!ignoreDirs.has(e.name)) walk(full, out);
    } else if (exts.has(path.extname(e.name)) && !isKitOwnFile(full, e.name)) {
      out.push(full);
    }
  }
  return out;
}

// 블록 주석은 상태를 추적해야 한다. 줄 단위로 "/* 로 시작하면 건너뛴다"는 휴리스틱은
// 여러 줄 주석 본문을 코드로 오탐하고, 이미 닫힌 주석 뒤의 진짜 위반(`/* 헤더 */ .b{color:#f00}`)을
// 놓친다. 주석 구간만 지우고 스캔하면 둘 다 사라진다(자리를 공백으로 채워 열 위치를 보존).
function stripComments(text) {
  let out = '', i = 0, block = false, line = false;
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    const ch = text[i];
    if (block) {
      if (two === '*/') { out += '  '; i += 2; block = false; continue; }
      out += ch === '\n' ? '\n' : ' '; i += 1; continue;
    }
    if (line) {
      if (ch === '\n') { out += '\n'; line = false; i += 1; continue; }
      out += ' '; i += 1; continue;
    }
    if (two === '/*') { out += '  '; i += 2; block = true; continue; }
    if (two === '//') { out += '  '; i += 2; line = true; continue; }
    out += ch; i += 1;
  }
  return out;
}

const findings = [];
for (const file of walk(target)) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = stripComments(text).split(/\r?\n/);
  for (const rule of rules.rules) {
    const re = new RegExp(rule.pattern, rule.unicode ? 'gu' : 'g');
    lines.forEach((line, i) => {
      re.lastIndex = 0;
      const m = re.exec(line);
      if (m) findings.push({ file: path.relative(target, file), line: i + 1, rule: rule.id, severity: rule.severity, hit: m[0].slice(0, 40), message: rule.message });
    });
  }
}

const errors = findings.filter((f) => f.severity === 'error');
for (const f of findings) {
  console.log(`${f.severity === 'error' ? 'ERROR' : 'WARN '} ${f.file}:${f.line} [${f.rule}] ${f.hit}\n        ${f.message}`);
}
for (const d of kitDrift) console.log('ERROR [kit-modified] ' + d);
console.log(`\n검사 완료 — error ${errors.length + kitDrift.length}건 · warn ${findings.length - errors.length}건`);
if (errors.length || kitDrift.length) process.exit(1);
