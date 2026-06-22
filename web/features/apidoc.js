/* apidoc — RestDoc/API 문서 보기 모듈 (view=api + 상세 패널 확장)
 * 데이터: data/openapi.json (lazy). operationId == 그래프 노드 id (오버로드 시 ~N 접미). */
(() => {
  'use strict';
  const FM = window.Flowmap;
  const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
  const AUTO_DEPTH = 1; // 스키마 트리 기본 펼침 깊이

  /* ---------- 데이터 로드 + operationId 인덱스 ---------- */
  let oaPromise = null;   // fetch 캐시
  let oaData = null;      // openapi 문서 (또는 null)
  let opIndex = null;     // Map<operationId, {path, method, op}>
  let baseIndex = null;   // Map<operationId에서 ~N 제거한 base id, entry[]>

  // 매니페스트가 있으면 프로젝트별 <project>.openapi.json 들을 병합, 없으면 단일 openapi.json 폴백
  function openapiFiles() {
    const projs = FM.MANIFEST && FM.MANIFEST.projects;
    if (projs && projs.length) {
      const files = projs.filter((p) => p.openapi).map((p) => p.openapi);
      if (files.length) return files;
    }
    return ['openapi.json'];
  }
  function mergeOpenapi(docs) {
    const out = { openapi: '3.1.0', info: { title: 'flowmap', version: '1.0.0' }, paths: {}, components: { schemas: {} } };
    for (const d of docs) {
      if (!d) continue;
      Object.assign(out.paths, d.paths || {});
      if (d.components && d.components.schemas) Object.assign(out.components.schemas, d.components.schemas);
    }
    return out;
  }

  function loadOpenapi() {
    if (!oaPromise) {
      oaPromise = Promise.all(openapiFiles().map((f) => FM.fetchData('data/' + f))).then((docs) => {
        const ok = docs.filter(Boolean);
        oaData = ok.length ? mergeOpenapi(ok) : null;
        if (oaData) buildIndex(oaData);
        return oaData;
      });
    }
    return oaPromise;
  }

  function buildIndex(d) {
    opIndex = new Map();
    baseIndex = new Map();
    const paths = d.paths || {};
    for (const path of Object.keys(paths)) {
      const item = paths[path] || {};
      for (const method of METHODS) {
        const op = item[method];
        if (!op || !op.operationId) continue;
        const entry = { path, method, op };
        opIndex.set(op.operationId, entry);
        const base = op.operationId.replace(/~\d+$/, '');
        if (!baseIndex.has(base)) baseIndex.set(base, []);
        baseIndex.get(base).push(entry);
      }
    }
  }

  // operationId → 그래프 노드 id (오버로드 ~N 접미는 base 노드로 연결)
  function nodeIdFor(opId) {
    if (FM.nodeById.has(opId)) return opId;
    const base = opId.replace(/~\d+$/, '');
    return FM.nodeById.has(base) ? base : null;
  }

  /* ---------- 공통 헬퍼 ---------- */
  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  function methodBadge(method) {
    const m = String(method || '').toLowerCase();
    const cls = METHODS.includes(m) ? 'm-' + m : 'm-any';
    return `<span class="nc-badge http ${cls}">${FM.esc(m.toUpperCase() || 'ANY')}</span>`;
  }

  function secHead(label, extra) {
    return el('div', 'doc-sec-head',
      FM.esc(label) + (extra ? ` <span class="doc-sec-extra">${FM.esc(extra)}</span>` : ''));
  }

  function statusClass(code) {
    const c = String(code)[0];
    if (c === '2') return 'doc-st-ok';
    if (c === '4') return 'doc-st-warn';
    if (c === '5') return 'doc-st-err';
    return 'doc-st-etc';
  }

  /* ---------- 스키마 해석 ---------- */
  function resolveRef(ref) {
    const m = /^#\/components\/schemas\/(.+)$/.exec(ref || '');
    if (!m) return null;
    const all = oaData && oaData.components && oaData.components.schemas;
    return { name: m[1], schema: (all && all[m[1]]) || null };
  }

  // 스키마 노드 분석 → { label, child:{schema,stack}|null, cycle, missing, isMap, chipsSrc }
  function expandInfo(schema, refStack) {
    const s = schema || {};
    if (s.$ref) {
      const r = resolveRef(s.$ref);
      if (!r || !r.schema) return { label: '', missing: s.$ref };
      if (refStack.indexOf(r.name) >= 0) return { label: r.name, cycle: true };
      const inner = expandInfo(r.schema, refStack.concat(r.name));
      return {
        label: r.name, child: inner.child, cycle: inner.cycle,
        isMap: inner.isMap, chipsSrc: r.schema,
      };
    }
    if (s.type === 'array' || s.items) {
      const inner = expandInfo(s.items || {}, refStack);
      return {
        label: 'array<' + (inner.label || 'any') + '>',
        child: inner.child, cycle: inner.cycle, missing: inner.missing,
        isMap: inner.isMap, chipsSrc: s.items,
      };
    }
    if (s.properties) {
      return { label: s.type || 'object', child: { schema: s, stack: refStack }, chipsSrc: s };
    }
    if (s.additionalProperties !== undefined) {
      return { label: '비정형 응답(Map)', isMap: true };
    }
    return { label: s.type || 'any', chipsSrc: s };
  }

  function chipHtml(schema) {
    const s = schema || {};
    let h = '';
    if (s.format) h += `<span class="doc-chip">${FM.esc(s.format)}</span>`;
    if (Array.isArray(s.enum) && s.enum.length) {
      s.enum.slice(0, 6).forEach((v) => {
        h += `<span class="doc-chip doc-chip-enum">${FM.esc(String(v))}</span>`;
      });
      if (s.enum.length > 6) h += `<span class="doc-chip">+${s.enum.length - 6}</span>`;
    }
    return h;
  }

  /* ---------- 스키마 트리 렌더러 (재귀) ---------- */
  function schemaRow(name, schema, required, refStack, depth) {
    const info = expandInfo(schema, refStack);
    const row = el('div', 'doc-node');
    const line = el('div', 'doc-row');
    row.appendChild(line);

    if (info.missing) {
      line.innerHTML =
        (name != null ? `<span class="doc-fname">${FM.esc(name)}</span>` : '') +
        `<span class="doc-warn">⚠ 스키마 누락: ${FM.esc(info.missing)}</span>`;
      return row;
    }

    let html = '';
    if (name != null) {
      html += `<span class="doc-fname">${FM.esc(name)}${required ? '<b class="doc-req">*</b>' : ''}</span>`;
    }
    html += `<span class="doc-ftype${info.isMap ? ' doc-ftype-map' : ''}">${FM.esc(info.label)}</span>`;
    html += chipHtml(info.chipsSrc);
    if (info.cycle) html += '<span class="doc-chip doc-cycle">↺ 재귀</span>';
    line.innerHTML = html;

    if (info.child && !info.cycle) {
      const btn = el('button', 'doc-toggle', '[+]');
      btn.type = 'button';
      line.appendChild(btn);
      let kids = null;
      let open = false;
      const setOpen = (v) => {
        open = v;
        btn.textContent = open ? '[–]' : '[+]';
        if (open && !kids) { // 펼칠 때 lazy 렌더 — 순환 차단은 refStack으로
          kids = el('div', 'doc-kids');
          const props = info.child.schema.properties || {};
          const req = info.child.schema.required || [];
          const keys = Object.keys(props);
          for (const k of keys) {
            kids.appendChild(schemaRow(k, props[k], req.indexOf(k) >= 0, info.child.stack, depth + 1));
          }
          if (!keys.length) kids.appendChild(el('div', 'doc-dim', '필드 없음'));
          row.appendChild(kids);
        }
        if (kids) kids.style.display = open ? '' : 'none';
      };
      btn.addEventListener('click', (e) => { e.stopPropagation(); setOpen(!open); });
      if (depth < AUTO_DEPTH) setOpen(true);
    }
    return row;
  }

  function schemaTree(schema) {
    const wrap = el('div', 'doc-tree');
    wrap.appendChild(schemaRow(null, schema, false, [], 0));
    return wrap;
  }

  /* ---------- operation 문서 블록 (상세 패널 + 카탈로그 인라인 공용) ---------- */
  function renderOpDoc(entry, desc) {
    const box = el('div', 'doc-op');
    box.appendChild(el('div', 'doc-op-head',
      methodBadge(entry.method) + `<span class="doc-op-path">${FM.esc(entry.path)}</span>`));
    if (desc) {
      const d = el('div', 'doc-desc');
      d.textContent = desc;
      box.appendChild(d);
    }

    const op = entry.op || {};

    // ▸ 파라미터
    const params = op.parameters || [];
    if (params.length) {
      box.appendChild(secHead('▸ 파라미터'));
      const t = document.createElement('table');
      t.className = 'detail-table doc-params';
      t.innerHTML =
        '<tr class="doc-th"><td>name</td><td>in</td><td>type</td></tr>' +
        params.map((p) => {
          const info = expandInfo(p.schema || {}, []);
          const fmt = p.schema && p.schema.format
            ? ` <span class="doc-chip">${FM.esc(p.schema.format)}</span>` : '';
          return `<tr><td class="doc-fname">${FM.esc(p.name || '')}${p.required ? '<b class="doc-req">*</b>' : ''}</td>` +
            `<td class="doc-pin">${FM.esc(p.in || '')}</td>` +
            `<td><span class="doc-ftype">${FM.esc(info.label)}</span>${fmt}</td></tr>`;
        }).join('');
      box.appendChild(t);
    }

    // ▸ Request Body
    const rb = op.requestBody;
    const rbContent = rb && rb.content;
    if (rbContent) {
      const mime = rbContent['application/json'] ? 'application/json' : Object.keys(rbContent)[0];
      const media = mime && rbContent[mime];
      if (media && media.schema) {
        box.appendChild(secHead('▸ Request Body', mime));
        box.appendChild(schemaTree(media.schema));
      }
    }

    // ▸ Responses
    const resps = op.responses || {};
    const codes = Object.keys(resps);
    if (codes.length) {
      box.appendChild(secHead('▸ Responses'));
      for (const code of codes) {
        const r = resps[code] || {};
        const row = el('div', 'doc-resp',
          `<span class="doc-st ${statusClass(code)}">${FM.esc(code)}</span>`);
        box.appendChild(row);
        const ct = r.content || {};
        const mime = ct['application/json'] ? 'application/json' : Object.keys(ct)[0];
        const media = mime && ct[mime];
        if (media && media.schema) {
          const tree = schemaTree(media.schema);
          tree.classList.add('doc-resp-tree');
          box.appendChild(tree);
        } else {
          row.insertAdjacentHTML('beforeend', '<span class="doc-dim">본문 없음</span>');
        }
      }
    }
    return box;
  }

  /* ---------- 1. 상세 패널 확장 ---------- */
  FM.registerDetailExtension((node, panelEl) => {
    if (!node || node.layer !== 'CONTROLLER' || !node.endpoint) return;

    // placeholder 먼저 append, 로드 후 채움 (fetchData 비동기)
    const sec = el('div', 'doc-section',
      '<div class="doc-sec-title">📄 API 문서</div><div class="doc-dim">문서 불러오는 중…</div>');
    panelEl.appendChild(sec);

    loadOpenapi().then((d) => {
      if (!sec.isConnected) return; // 패널이 이미 다시 그려짐
      if (!d) {
        sec.innerHTML = '<div class="doc-none">openapi.json 없음 — <code>scripts/sync-data.sh</code> 실행 후 새로고침</div>';
        return;
      }
      const entries = baseIndex.get(node.id) || [];
      if (!entries.length) {
        sec.innerHTML = '<div class="doc-none">OpenAPI 문서 없음</div>';
        return;
      }
      sec.innerHTML = '<div class="doc-sec-title">📄 API 문서</div>';
      for (const entry of entries) sec.appendChild(renderOpDoc(entry, node.description));
    });
  });

  /* ---------- 2. API 카탈로그 뷰 (view=api, asvc=, q=) ---------- */
  let renderSeq = 0; // 비동기 채움 중 뷰 이탈 가드

  function pushApiUrl(params) {
    const p = {};
    if (params.asvc) p.asvc = params.asvc;
    if (params.q) p.q = params.q;
    FM.pushViewUrl('api', p);
  }

  function renderBreadcrumb(asvc) {
    const bc = document.getElementById('breadcrumb');
    if (!bc) return;
    bc.style.display = 'flex';
    bc.innerHTML = '<span class="bc-link" data-doc-root>📖 API 문서</span>' +
      (asvc ? `<span class="bc-sep">›</span><span class="bc-link">${FM.svcBadge(asvc)}</span>` : '');
    const root = bc.querySelector('[data-doc-root]');
    if (root && asvc) {
      root.addEventListener('click', () => { pushApiUrl({}); render(); });
    }
  }

  function serviceCounts() {
    const map = new Map();
    for (const entry of opIndex.values()) {
      const tag = (entry.op.tags && entry.op.tags[0]) || '(기타)';
      map.set(tag, (map.get(tag) || 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }

  function entriesOfService(svc) {
    const out = [];
    for (const entry of opIndex.values()) {
      const tags = entry.op.tags || [];
      const tag = tags[0] || '(기타)';
      if (tag === svc || tags.indexOf(svc) >= 0) out.push(entry);
    }
    out.sort((a, b) => a.path === b.path
      ? METHODS.indexOf(a.method) - METHODS.indexOf(b.method)
      : a.path.localeCompare(b.path));
    return out;
  }

  function renderEmptyData(host) {
    host.appendChild(el('div', 'browse-empty',
      '<div class="be-ico">📖</div>' +
      '<div class="be-msg">openapi.json 데이터가 없습니다.<br>' +
      '<code class="doc-cmd">scripts/sync-data.sh</code> 를 실행한 뒤 새로고침하세요.</div>' +
      '<div class="be-actions"><button class="btn" data-doc-ov>🗺️ 전체보기로</button></div>'));
    const btn = host.querySelector('[data-doc-ov]');
    if (btn) btn.addEventListener('click', () => FM.setOverview(true));
  }

  // 서비스 카드 목록
  function renderServiceList(host) {
    const grid = el('div', 'doc-svc-grid');
    for (const [svc, count] of serviceCounts()) {
      const card = el('div', 'doc-svc-card',
        `<div class="doc-svc-name">${FM.svcBadge(svc, 'lg')}</div>` +
        `<div class="doc-svc-count">${count} endpoints</div>`);
      card.addEventListener('click', () => { pushApiUrl({ asvc: svc }); render(); });
      grid.appendChild(card);
    }
    if (!grid.childElementCount) {
      grid.appendChild(el('div', 'doc-dim', '문서화된 endpoint가 없습니다.'));
    }
    host.appendChild(grid);
  }

  // 마스터-디테일: 경로 그룹별 endpoint 행 목록
  function renderEndpointList(host, asvc, q0) {
    const entries = entriesOfService(asvc);

    const bar = el('div', 'doc-toolbar');
    const input = document.createElement('input');
    input.className = 'doc-filter';
    input.type = 'text';
    input.placeholder = '경로 / 메서드 / 설명 필터…';
    input.value = q0 || '';
    const count = el('span', 'grid-count');
    bar.appendChild(input);
    bar.appendChild(count);
    host.appendChild(bar);

    const list = el('div', 'doc-ep-list');
    host.appendChild(list);

    if (!entries.length) {
      list.appendChild(el('div', 'doc-dim', '이 서비스에 문서화된 endpoint가 없습니다.'));
      count.textContent = '0 endpoints';
      return;
    }

    // 1단 경로 그룹핑
    const groups = new Map();
    for (const entry of entries) {
      const seg = '/' + (entry.path.split('/')[1] || '');
      if (!groups.has(seg)) groups.set(seg, []);
      groups.get(seg).push(entry);
    }

    const rows = []; // {rowEl, groupEl, entry, desc, inlineEl}
    let selRow = null;

    for (const [seg, list2] of Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
      const g = el('div', 'doc-group');
      g.appendChild(el('div', 'doc-group-head', FM.esc(seg)));
      const body = el('div', 'doc-group-body');
      g.appendChild(body);
      list.appendChild(g);

      for (const entry of list2) {
        const nid = nodeIdFor(entry.op.operationId);
        const node = nid ? FM.nodeById.get(nid) : null;
        const desc = (node && node.description) || '';

        const row = el('div', 'doc-ep-row' + (nid ? '' : ' doc-ep-noGraph'));
        row.innerHTML =
          methodBadge(entry.method) +
          `<span class="doc-ep-path">${FM.esc(entry.path)}</span>` +
          (desc ? `<span class="doc-ep-desc">${FM.esc(desc)}</span>` : '') +
          (nid ? '' : '<span class="doc-ep-nograph">그래프 없음</span>') +
          (nid ? '<button class="doc-ep-go" type="button" title="이 노드 기준 호출관계분석">⟲</button>' : '');
        body.appendChild(row);

        let inlineEl = null;
        row.addEventListener('click', () => {
          if (selRow && selRow !== row) selRow.classList.remove('doc-ep-sel');
          selRow = row;
          row.classList.add('doc-ep-sel');
          if (nid) {
            FM.setSel(nid); // 상세 패널 → 확장 훅이 문서 섹션을 렌더
          } else {
            // 그래프 노드 미존재 → 행 아래 인라인 문서 전개/접기
            if (inlineEl) {
              inlineEl.remove();
              inlineEl = null;
            } else {
              inlineEl = el('div', 'doc-inline');
              inlineEl.appendChild(renderOpDoc(entry, ''));
              row.insertAdjacentElement('afterend', inlineEl);
            }
          }
        });
        const go = row.querySelector('.doc-ep-go');
        if (go) {
          go.addEventListener('click', (e) => {
            e.stopPropagation();
            FM.setFocus(nid);
          });
        }
        rows.push({ row, group: g, entry, desc, getInline: () => inlineEl });
      }
    }

    function applyFilter(q) {
      let shown = 0;
      for (const r of rows) {
        const hit = !q || FM.matches(q, r.entry.path, r.entry.method, r.desc, r.entry.op.operationId);
        r.row.style.display = hit ? '' : 'none';
        const inl = r.getInline();
        if (inl) inl.style.display = hit ? '' : 'none';
        if (hit) shown++;
      }
      for (const g of list.querySelectorAll('.doc-group')) {
        const any = Array.from(g.querySelectorAll('.doc-ep-row'))
          .some((rw) => rw.style.display !== 'none');
        g.style.display = any ? '' : 'none';
      }
      count.textContent = `${shown} / ${rows.length} endpoints`;
    }
    applyFilter(q0 || '');

    let debounce = 0;
    input.addEventListener('input', () => {
      const q = input.value.trim();
      applyFilter(q);
      clearTimeout(debounce);
      debounce = setTimeout(() => pushApiUrl({ asvc, q }), 400); // q 파라미터 동기화
    });
  }

  function render() {
    const seq = ++renderSeq;
    const asvc = FM.param('asvc') || '';
    const q = FM.param('q') || '';

    renderBreadcrumb(asvc);

    const cols = document.getElementById('columns');
    cols.className = 'doc-host';
    cols.innerHTML = '<div class="feature-loading">📖 API 문서 불러오는 중…</div>';

    loadOpenapi().then((d) => {
      if (seq !== renderSeq || FM.state.view !== 'api') return; // 이탈/재렌더 가드
      cols.innerHTML = '';
      const host = el('div', 'doc-wrap');
      cols.appendChild(host);
      if (!d) { renderEmptyData(host); return; }
      if (asvc) renderEndpointList(host, asvc, q);
      else renderServiceList(host);
    });
  }

  FM.registerView('api', {
    render,
    escape() {
      if (FM.param('asvc')) { pushApiUrl({}); render(); }
      else FM.setOverview(true);
    },
  });
})();
