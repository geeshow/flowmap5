#!/usr/bin/env node
// 기능 모듈 정적 검증: web/features/*.js
// 사용법: node tests/check-features.mjs
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FEATURES = join(ROOT, 'web', 'features');

let failCount = 0;
const pass = (msg) => console.log(`✅ ${msg}`);
const fail = (msg) => { failCount++; console.log(`❌ ${msg}`); };
const skip = (msg) => console.log(`⏭️  ${msg}`);

if (!existsSync(FEATURES)) {
  skip('web/features/ 디렉토리 없음 — 모듈 미작성 (다른 팀원 병렬 작업 중), skip');
  console.log('\n✅ 검사 대상 없음 — 통과 처리');
  process.exit(0);
}

const jsFiles = readdirSync(FEATURES).filter((f) => f.endsWith('.js')).sort();
if (jsFiles.length === 0) {
  skip('web/features/ 에 *.js 없음 — 모듈 미작성, skip');
  console.log('\n✅ 검사 대상 없음 — 통과 처리');
  process.exit(0);
}

console.log(`검사 대상 모듈: ${jsFiles.length}개\n`);

for (const file of jsFiles) {
  const path = join(FEATURES, file);
  const name = basename(file, '.js');
  console.log(`--- ${file} ---`);
  const src = readFileSync(path, 'utf8');

  // 1. 문법 검사 (node --check)
  try {
    execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' });
    pass(`${file}: 문법 검사 통과 (node --check)`);
  } catch (e) {
    fail(`${file}: 문법 오류 — ${(e.stderr?.toString() ?? e.message).trim().split('\n').slice(0, 3).join(' / ')}`);
  }

  // 2. registerView( 또는 registerDetailExtension( 호출 존재
  if (src.includes('registerView(') || src.includes('registerDetailExtension(')) {
    pass(`${file}: registerView/registerDetailExtension 호출 존재`);
  } else {
    fail(`${file}: registerView( 또는 registerDetailExtension( 호출 없음`);
  }

  // 3. 금지 패턴
  const banned = [
    ['history.pushState(', 'pushViewUrl 우회 — history.pushState 직접 호출'],
    ['document.write', 'document.write 사용'],
    ['eval(', 'eval 사용'],
  ];
  let bannedHit = false;
  for (const [pattern, desc] of banned) {
    // eval( 은 단어 경계 확인 (예: someEval( 오탐 방지)
    const re = pattern === 'eval('
      ? /(^|[^\w.])eval\(/
      : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (re.test(src)) {
      const line = src.split('\n').findIndex((l) => re.test(l)) + 1;
      fail(`${file}: 금지 패턴 발견 — ${desc} (line ${line})`);
      bannedHit = true;
    }
  }
  if (!bannedHit) pass(`${file}: 금지 패턴 없음`);

  // 4. 대응 .css 파일 존재
  const cssPath = join(FEATURES, `${name}.css`);
  if (existsSync(cssPath)) pass(`${file}: 대응 CSS 존재 (${name}.css)`);
  else fail(`${file}: 대응 CSS 없음 (${name}.css 미존재)`);

  console.log('');
}

console.log(failCount === 0 ? '✅ 전체 통과' : `❌ 실패 ${failCount}건`);
process.exit(failCount === 0 ? 0 : 1);
