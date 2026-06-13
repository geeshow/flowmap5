/* flowmap 기능 모듈: git 커밋 영향도 분석 (view=commits)
 * 계약: docs/FEATURE-API.md — window.Flowmap API 표면만 사용한다. */
(() => {
  'use strict';
  const FM = window.Flowmap;
  const DATA_URL = 'data/impact.json';
  const MAX_NODES = 200;   // BFS 노드 폭증 가드 (기존 200호출 상한과 동일 정책)
  const MAX_DEPTH = 3;     // 역방향(피호출) BFS 최대 단계

  // 모듈 상태 — render()는 항상 URL 파라미터에서 복원하므로 여기엔 데이터 캐시/필터만 둔다
  let data;                          // undefined=미로드, null=404/오류, object=로드 완료
  const commitBySha = new Map();     // shortSha -> commit
  let railFilter = '';               // 커밋 레일 텍스트 필터 (URL 비동기 상태 아님)
  let renderSeq = 0;                 // fetch 경합 가드

  /* ───────── 유틸 ───────── */

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  function fmtDate(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return `${String(d.getFullYear()).slice(2)}.${d.getMonth() + 1}.${d.getDate()}`;
  }

  function shaChip(sha) {
    return `<span class="imp-sha">◆ ${FM.esc(sha)}</span>`;
  }

  async function ensureData() {
    if (data === undefined) {
      const d = await FM.fetchData(DATA_URL);
      data = d || null;
      if (data && Array.isArray(data.commits)) {
        data.commits.forEach(c => commitBySha.set(c.shortSha, c));
      }
    }
    return data;
  }

  /* ───────── URL 상태 ───────── */

  function parseSel() {
    const raw = FM.param('commit') || '';
    return raw.split(',').map(s => s.trim()).filter(s => s && commitBySha.has(s));
  }

  function pushSel(shas, ep) {
    const p = {};
    if (shas.length) p.commit = shas.join(',');
    if (ep) p.ep = ep;
    FM.pushViewUrl('commits', p);
    render();
  }

  /* ───────── 뷰 등록 ───────── */

  FM.registerView('commits', {
    render,
    escape() {
      if (parseSel().length || FM.param('ep')) pushSel([], '');
      else FM.setOverview(true);
    },
  });

  function render() {
    const seq = ++renderSeq;
    if (data === undefined) {
      const cols = document.getElementById('columns');
      cols.className = 'imp-view'; cols.innerHTML = '';
      drawBreadcrumb([]);
      // 200ms 안에 오면 로딩 UI 생략
      const t = setTimeout(() => {
        if (renderSeq === seq && data === undefined) {
          cols.innerHTML = '<div class="imp-loading">불러오는 중…' +
            '<div class="imp-skel"></div><div class="imp-skel"></div><div class="imp-skel"></div></div>';
        }
      }, 200);
      ensureData().then(() => {
        clearTimeout(t);
        if (renderSeq === seq) paint();
      });
      return;
    }
    paint();
  }

  /* ───────── 본 렌더 ───────── */

  function paint() {
    const cols = document.getElementById('columns');
    cols.className = 'imp-view';
    cols.innerHTML = '';
    FM.setCanvasEdges([]);

    if (data === null) { drawBreadcrumb([]); renderMissing(cols); return; }

    const selected = parseSel();
    const ep = FM.param('ep') || '';
    drawBreadcrumb(selected);

    cols.appendChild(buildRail(selected));

    const main = el('div', 'imp-main');
    cols.appendChild(main);
    if (selected.length) renderGraph(main, selected, ep);
    else renderAggregate(main, ep);

    requestAnimationFrame(() => { FM.drawConnectors(); FM.applyHighlight(); });
  }

  function drawBreadcrumb(selected) {
    const bc = document.getElementById('breadcrumb');
    bc.style.display = 'flex';
    let html = '<span class="bc-link" data-imp-root>🧾 커밋 영향도</span>';
    if (selected.length) {
      html += '<span class="bc-sep">›</span>' +
        `<span class="bc-focus">◆ ${FM.esc(selected[0])}${selected.length > 1 ? ` (+${selected.length - 1})` : ''}</span>`;
    }
    bc.innerHTML = html;
    const root = bc.querySelector('[data-imp-root]');
    if (root) root.onclick = () => pushSel([], '');
  }

  /* ───────── 빈 상태 (impact.json 없음) ───────── */

  function renderMissing(cols) {
    const box = el('div', 'browse-empty imp-empty',
      '<div class="be-ico">🧾</div>' +
      '<div class="be-msg">커밋 영향도 데이터가 없습니다<br>' +
      '<span class="hint">아래 명령으로 <code>data/impact.json</code>을 생성한 뒤 새로고침하세요.</span></div>' +
      '<pre class="imp-code">scripts/sync-data.sh</pre>' +
      '<div class="be-actions"><button class="btn" data-imp-home>🗺️ 전체보기로</button></div>');
    box.querySelector('[data-imp-home]').onclick = () => FM.setOverview(true);
    cols.appendChild(box);
  }

  /* ───────── 커밋 레일 ───────── */

  function buildRail(selected) {
    const rail = el('div', 'imp-rail');
    const selSet = new Set(selected);

    const head = el('div', 'imp-rail-head',
      `<div class="imp-rail-title">커밋 <span class="grid-count">${FM.esc(String(data.commitCount))}</span></div>`);
    const filter = el('input', 'imp-filter');
    filter.type = 'text';
    filter.placeholder = '작성자 / 메시지 / 파일 필터…';
    filter.value = railFilter;
    head.appendChild(filter);
    rail.appendChild(head);

    const list = el('div', 'imp-list');
    rail.appendChild(list);
    const empty = el('div', 'imp-rail-empty', '일치하는 커밋이 없습니다');
    empty.style.display = 'none';
    list.appendChild(empty);

    data.commits.forEach(c => list.appendChild(commitCard(c, selSet, selected)));

    const apply = () => {
      const q = railFilter.trim().toLowerCase();
      let shown = 0;
      list.querySelectorAll('.imp-commit').forEach(card => {
        const hit = !q || card.dataset.search.includes(q);
        card.style.display = hit ? '' : 'none';
        if (hit) shown++;
      });
      empty.style.display = shown ? 'none' : '';
    };
    filter.oninput = () => { railFilter = filter.value; apply(); };
    apply();
    return rail;
  }

  function commitCard(c, selSet, selected) {
    const on = selSet.has(c.shortSha);
    const card = el('div', 'imp-commit' + (on ? ' on' : ''));
    card.dataset.search =
      (c.author + ' ' + c.subject + ' ' + c.shortSha + ' ' + (c.changedFiles || []).join(' ')).toLowerCase();

    const noCode = !(c.changedNodes && c.changedNodes.length);
    card.innerHTML =
      `<label class="imp-ck"><input type="checkbox" ${on ? 'checked' : ''}></label>` +
      `<div class="imp-cbody">` +
        `<div class="imp-crow1">${shaChip(c.shortSha)}<span class="imp-csubj" title="${FM.escAttr(c.subject)}">${FM.esc(c.subject)}</span></div>` +
        `<div class="imp-cmeta">${FM.esc(c.author)} · ${FM.esc(fmtDate(c.date))}</div>` +
        `<div class="imp-cchips">` +
          (noCode
            ? `<span class="imp-cc none">코드 영향 없음</span><span class="imp-cc">파일 ${c.changedFiles.length}</span>`
            : `<span class="imp-cc">변경 ${c.changedNodes.length}</span><span class="imp-cc">영향 ${c.impactedEndpoints.length}</span>`) +
        `</div>` +
      `</div>`;

    const ck = card.querySelector('input');
    ck.onclick = e => e.stopPropagation();
    ck.onchange = () => {
      const next = selected.filter(s => s !== c.shortSha);
      if (ck.checked) next.push(c.shortSha);
      pushSel(next, '');
    };
    // 카드 본문 클릭 = 단일 선택 (기존 선택 대체)
    card.onclick = () => pushSel([c.shortSha], '');
    return card;
  }

  /* ───────── 커밋 미선택: endpointImpact 집계 테이블 ───────── */

  function renderAggregate(main, ep) {
    main.appendChild(el('div', 'imp-bar',
      `<span class="imp-bar-title">🧾 ${FM.esc(data.branch)} 브랜치</span>` +
      `<span class="imp-cc">최근 ${FM.esc(String(data.commitCount))} 커밋</span>` +
      `<span class="imp-cc">추적 깊이 ${FM.esc(String(data.depth))}</span>` +
      `<span class="imp-cc">변경 노드 ${FM.esc(String(data.changedNodeCount))}</span>` +
      `<span class="hint">커밋을 선택하면 영향 그래프가 표시됩니다 — 체크박스로 여러 커밋을 묶어볼 수 있습니다</span>`));

    let rows = (data.endpointImpact || []).slice()
      .sort((a, b) => b.commits.length - a.commits.length);

    if (ep) {
      const chip = el('div', 'imp-epfilter',
        `엔드포인트 필터: <code>${FM.esc(ep)}</code> <button class="btn imp-x" title="필터 해제">✕</button>`);
      chip.querySelector('button').onclick = () => pushSel([], '');
      main.appendChild(chip);
      rows = rows.filter(r => r.id === ep);
    }

    if (!rows.length) {
      main.appendChild(el('div', 'browse-empty imp-empty',
        '<div class="be-ico">◇</div><div class="be-msg">영향받는 엔드포인트가 없습니다</div>'));
      return;
    }

    const table = el('div', 'imp-table');
    table.appendChild(el('div', 'imp-trow imp-thead',
      '<span class="imp-tep">영향 엔드포인트</span><span class="imp-tsvc">서비스</span><span class="imp-tcommits">영향 커밋</span>'));

    rows.forEach(r => {
      const row = el('div', 'imp-trow');
      const m = (r.httpMethod || 'ANY').toUpperCase();
      row.innerHTML =
        `<span class="imp-tep"><span class="nc-badge http ${FM.methodClass(m)}">${FM.esc(m)}</span>` +
        `<code class="imp-path-code" title="${FM.escAttr(r.id)}">${FM.esc(r.endpoint || r.id)}</code>` +
        (r.description ? `<span class="imp-tdesc">${FM.esc(r.description)}</span>` : '') + `</span>` +
        `<span class="imp-tsvc">${FM.esc(r.service || '')}</span>` +
        `<span class="imp-tcommits"></span>`;

      const cell = row.querySelector('.imp-tcommits');
      r.commits.forEach(sha => {
        const chip = el('button', 'imp-sha imp-sha-btn', `◆ ${FM.esc(sha)}`);
        const c = commitBySha.get(sha);
        if (c) chip.title = c.subject;
        chip.onclick = e => { e.stopPropagation(); pushSel([sha], ''); };
        cell.appendChild(chip);
      });

      if (FM.nodeById.has(r.id)) {
        row.classList.add('clickable');
        row.onclick = () => FM.setSel(r.id);
      }
      table.appendChild(row);
    });
    main.appendChild(table);
  }

  /* ───────── 커밋 선택: 영향 그래프 ───────── */

  function renderGraph(main, selected, ep) {
    // 선택 커밋 합집합 수집
    const changedSha = new Map();   // nodeId -> [shortSha…]  (inGraph만)
    const outOfGraph = [];          // {id, sha}
    const epIds = new Set();        // 영향 엔드포인트 합집합
    const allFiles = [];            // {sha, file}
    selected.forEach(sha => {
      const c = commitBySha.get(sha);
      if (!c) return;
      (c.changedNodes || []).forEach(n => {
        if (!n.inGraph) { outOfGraph.push({ id: n.id, sha }); return; }
        if (!changedSha.has(n.id)) changedSha.set(n.id, []);
        changedSha.get(n.id).push(sha);
      });
      (c.impactedEndpoints || []).forEach(e => epIds.add(e.id));
      (c.changedFiles || []).forEach(f => allFiles.push({ sha, file: f }));
    });

    const bases = [...changedSha.keys()].filter(id => FM.nodeById.has(id));

    // 역방향(피호출) BFS — FM.inEdges, 최대 MAX_DEPTH 단계, MAX_NODES 가드
    const level = new Map();        // id -> 0..MAX_DEPTH (0=변경 노드)
    const edges = [];
    const edgeSeen = new Set();
    let truncated = false;
    bases.forEach(id => level.set(id, 0));
    let frontier = bases.slice();
    for (let d = 0; d < MAX_DEPTH && frontier.length; d++) {
      const next = [];
      for (const id of frontier) {
        for (const e of (FM.inEdges.get(id) || [])) {
          const caller = e.source;
          if (!FM.nodeById.has(caller)) continue;
          if (!level.has(caller)) {
            if (level.size >= MAX_NODES) { truncated = true; continue; }
            level.set(caller, d + 1);
            next.push(caller);
          }
          const key = `${e.source}→${e.target}·${e.relation}·${e.mode}`;
          if (!edgeSeen.has(key)) { edgeSeen.add(key); edges.push(e); }
        }
      }
      frontier = next;
    }

    // 상단 분석 바
    main.appendChild(buildBar(selected, changedSha, epIds, truncated, outOfGraph));

    if (!bases.length) {
      // 그래프에 그릴 변경 노드 없음 — changedFiles는 보여줌
      const box = el('div', 'browse-empty imp-empty',
        '<div class="be-ico">∅</div><div class="be-msg">선택한 커밋의 변경이 호출 그래프에 닿지 않습니다 (코드 영향 없음)</div>');
      main.appendChild(box);
      if (allFiles.length) {
        const fl = el('div', 'imp-files', '<div class="imp-files-head">변경 파일</div>');
        allFiles.forEach(({ sha, file }) =>
          fl.appendChild(el('div', 'imp-file', `${shaChip(sha)} <code>${FM.esc(file)}</code>`)));
        main.appendChild(fl);
      }
      return;
    }

    // 컬럼 전개 — 왼쪽 끝 = 가장 먼 피호출(영향 엔드포인트), 오른쪽 = 변경 노드 기준
    const byLevel = new Map();
    level.forEach((lv, id) => {
      if (!byLevel.has(lv)) byLevel.set(lv, []);
      byLevel.get(lv).push(id);
    });
    const maxLv = Math.max(...byLevel.keys());

    const gwrap = el('div', 'imp-gwrap');
    const graph = el('div', 'imp-graph');
    gwrap.appendChild(graph);
    main.appendChild(gwrap);
    let scrollRaf = 0;
    gwrap.addEventListener('scroll', () => {
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; FM.drawConnectors(); });
    });

    for (let lv = maxLv; lv >= 0; lv--) {
      const ids = byLevel.get(lv);
      if (!ids || !ids.length) continue;
      const col = el('div', 'column' + (lv === 0 ? ' imp-base' : ''));
      col.appendChild(FM.mkHead(lv === 0 ? `◆ 변경 노드 (${ids.length})` : `피호출 ${lv}단계`));
      ids.forEach(id => {
        const card = FM.makeCard(id, {});
        const node = FM.nodeById.get(id);
        const shas = changedSha.get(id);
        if (shas) {
          card.classList.add('imp-changed');
          card.prepend(el('div', 'imp-flag',
            `◆ ${FM.esc(shas[0])}${shas.length > 1 ? ` +${shas.length - 1}` : ''}`));
        } else if (node && node.layer === 'CONTROLLER') {
          card.classList.add('imp-endpoint');
          card.prepend(el('div', 'imp-flag ep', '◇ 영향'));
        } else {
          card.classList.add('imp-path');
        }
        if (id === ep) card.classList.add('imp-ep-target');
        col.appendChild(card);
      });
      graph.appendChild(col);
    }

    FM.setCanvasEdges(edges);

    // ep 역조회 진입: 해당 엔드포인트 카드로 스크롤 + 상세 패널
    if (ep && level.has(ep)) {
      requestAnimationFrame(() => {
        const card = FM.cardEls && FM.cardEls.get && FM.cardEls.get(ep);
        if (card && card.scrollIntoView) card.scrollIntoView({ block: 'center', inline: 'nearest' });
        if (FM.state.sel !== ep) FM.setSel(ep);
      });
    }
  }

  function buildBar(selected, changedSha, epIds, truncated, outOfGraph) {
    const bar = el('div', 'imp-bar');

    selected.forEach(sha => {
      const c = commitBySha.get(sha);
      const chip = el('span', 'imp-barchip',
        `<span class="imp-sha">◆ ${FM.esc(sha)}</span>` +
        `<span class="imp-barsubj" title="${FM.escAttr(c ? c.subject : '')}">${FM.esc(c ? c.subject : '')}</span>` +
        `<button class="imp-x" title="이 커밋 제거">✕</button>`);
      chip.querySelector('.imp-x').onclick = () => pushSel(selected.filter(s => s !== sha), '');
      bar.appendChild(chip);
    });

    bar.appendChild(el('span', 'imp-cc', `변경 ${changedSha.size}`));
    bar.appendChild(el('span', 'imp-cc', `영향 엔드포인트 ${epIds.size}`));
    if (truncated) bar.appendChild(el('span', 'imp-cc warn', `(일부만 표시 — ${MAX_NODES}노드 상한)`));

    if (outOfGraph.length) {
      const det = el('details', 'imp-ext');
      det.innerHTML = `<summary>그래프 외 변경 ${outOfGraph.length}건</summary>`;
      const body = el('div', 'imp-ext-body');
      outOfGraph.forEach(({ id, sha }) =>
        body.appendChild(el('div', 'imp-ext-item', `${shaChip(sha)} <code>${FM.esc(id)}</code>`)));
      det.appendChild(body);
      bar.appendChild(det);
    }

    const clear = el('button', 'btn', '전체 해제');
    clear.onclick = () => pushSel([], '');
    bar.appendChild(clear);
    return bar;
  }

  /* ───────── 상세 패널 확장: CONTROLLER → 영향 커밋 ───────── */

  FM.registerDetailExtension((node, panelEl) => {
    if (!node || node.layer !== 'CONTROLLER') return;

    const append = d => {
      if (!d || !panelEl.isConnected) return;
      const entry = (d.endpointImpact || []).find(e => e.id === node.id);
      if (!entry || !entry.commits.length) return;   // 해당 없으면 빈 섹션 금지

      const sec = el('div', 'imp-detail',
        `<div class="imp-detail-head">◆ 영향 커밋 ${entry.commits.length}건</div>`);
      entry.commits.forEach(sha => {
        const c = commitBySha.get(sha);
        const row = el('div', 'imp-detail-row',
          shaChip(sha) + `<span class="imp-detail-subj">${FM.esc(c ? c.subject : '')}</span>`);
        row.onclick = () => FM.openView('commits', { commit: sha, ep: node.id });
        sec.appendChild(row);
      });
      const go = el('button', 'btn imp-detail-go', '🧾 커밋 영향도에서 보기 →');
      go.onclick = () => FM.openView('commits', { commit: entry.commits.join(','), ep: node.id });
      sec.appendChild(go);
      panelEl.appendChild(sec);
    };

    if (data !== undefined) append(data);
    else ensureData().then(append);   // 캐시 로드 후 비동기 append
  });
})();
