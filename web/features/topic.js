/* flowmap 기능 모듈 — Kafka 토픽 영향도 분석 (view=topic)
 * 계약: docs/FEATURE-API.md · 설계: docs/DESIGN-v2.md §2 (기능 B)
 * URL: ?view=topic&topic=<토픽노드id>&e2e=1|0  (topic 없으면 전체 토픽 목록)
 */
(() => {
  'use strict';
  const FM = window.Flowmap;

  const MAX_NODES = 200; // 활성 노드 폭주 가드
  const MAX_DEPTH = 6;   // end-to-end BFS 최대 단계

  /* ───────── 데이터 헬퍼 ───────── */

  function isTopicNode(n) {
    return !!n && n.layer === 'RESOURCE' && n.resourceType === 'kafka-topic';
  }
  function allTopics() {
    return FM.NODES.filter(isTopicNode);
  }
  function topicLabel(n) {
    return n ? (n.method || String(n.id).replace(/^kafka:/, '')) : '';
  }
  function produceEdgesOf(topicId) {
    return (FM.inEdges.get(topicId) || []).filter((e) => e.relation === 'kafka:produce');
  }
  function consumeEdgesOf(topicId) {
    return (FM.outEdges.get(topicId) || []).filter((e) => e.relation === 'kafka:consume');
  }
  function projOf(id) {
    const n = FM.nodeById.get(id);
    return (n && n.project) || null;
  }
  function readE2e() {
    return FM.param('e2e') !== '0'; // 기본 1
  }

  /* ───────── BFS 추적 ───────── */

  // produce 측: 토픽 ← producer 메서드 ← … ← CONTROLLER 엔드포인트 (FM.inEdges 역방향)
  function traceProduce(topicId, maxDepth, budget) {
    const depth = new Map(); // id → 단계 (1 = 직접 producer)
    const group = new Map(); // id → 서비스(project)
    const queue = [];
    produceEdgesOf(topicId).forEach((e) => {
      const src = e.source;
      if (depth.has(src) || !FM.nodeById.has(src)) return;
      if (budget.left <= 0) { budget.truncated = true; return; }
      budget.left--;
      depth.set(src, 1);
      group.set(src, projOf(src) || '(미지정)');
      queue.push(src);
    });
    while (queue.length) {
      const id = queue.shift();
      const d = depth.get(id);
      if (d >= maxDepth) continue;
      const node = FM.nodeById.get(id);
      if (node && node.layer === 'CONTROLLER') continue; // 엔드포인트 도달 — 더 거슬러가지 않음
      (FM.inEdges.get(id) || []).forEach((e) => {
        if (e.relation && e.relation.indexOf('kafka:') === 0) return; // 다른 토픽 체인으로 역류 금지
        const src = e.source;
        if (depth.has(src)) return;
        const sn = FM.nodeById.get(src);
        if (!sn || isTopicNode(sn)) return;
        if (budget.left <= 0) { budget.truncated = true; return; }
        budget.left--;
        depth.set(src, d + 1);
        group.set(src, projOf(src) || group.get(id) || '(미지정)');
        queue.push(src);
      });
    }
    return { depth, group };
  }

  // consume 측: 토픽 → 리스너 → … → leaf(인프라/외부) 또는 다음 토픽 (FM.outEdges 순방향)
  function traceConsume(topicId, maxDepth, budget) {
    const depth = new Map();
    const group = new Map();
    const nextTopics = new Map(); // 다음 토픽 id → Set<발행한 서비스>
    const queue = [];
    consumeEdgesOf(topicId).forEach((e) => {
      const tgt = e.target;
      if (depth.has(tgt) || !FM.nodeById.has(tgt)) return;
      if (budget.left <= 0) { budget.truncated = true; return; }
      budget.left--;
      depth.set(tgt, 1);
      group.set(tgt, projOf(tgt) || '(미지정)');
      queue.push(tgt);
    });
    while (queue.length) {
      const id = queue.shift();
      const d = depth.get(id);
      if (d >= maxDepth) continue;
      const node = FM.nodeById.get(id);
      if (node && (node.layer === 'EXTERNAL' || FM.isInfra(id, node))) continue; // leaf — 더 펼치지 않음
      (FM.outEdges.get(id) || []).forEach((e) => {
        const tgt = e.target;
        const tn = FM.nodeById.get(tgt);
        if (isTopicNode(tn)) { // 2차 토픽 체인 — 미니 카드로만 표시
          if (!nextTopics.has(tgt)) nextTopics.set(tgt, new Set());
          nextTopics.get(tgt).add(group.get(id) || '(미지정)');
          return;
        }
        if (depth.has(tgt) || !tn) return;
        if (budget.left <= 0) { budget.truncated = true; return; }
        budget.left--;
        depth.set(tgt, d + 1);
        group.set(tgt, projOf(tgt) || group.get(id) || '(미지정)');
        queue.push(tgt);
      });
    }
    return { depth, group, nextTopics };
  }

  // 서비스별 묶음: Map<svc, id[]> — produce 측은 깊은 단계(엔드포인트)부터, consume 측은 가까운 단계부터
  function groupBySvc(trace, deepFirst) {
    const m = new Map();
    trace.depth.forEach((d, id) => {
      const svc = trace.group.get(id) || '(미지정)';
      if (!m.has(svc)) m.set(svc, []);
      m.get(svc).push(id);
    });
    m.forEach((ids) => {
      ids.sort((a, b) => {
        const dd = trace.depth.get(a) - trace.depth.get(b);
        return (deepFirst ? -dd : dd) || String(a).localeCompare(String(b));
      });
    });
    return new Map([...m.entries()].sort((a, b) => a[0].localeCompare(b[0])));
  }

  /* ───────── 이동/탈출 ───────── */

  function recenter(topicId, e2e) {
    FM.pushViewUrl('topic', { topic: topicId, e2e: e2e ? '1' : '0' });
    render();
  }
  function gotoList(e2e) {
    FM.pushViewUrl('topic', { e2e: e2e ? '1' : '0' });
    render();
  }
  function goKafka() {
    if (typeof FM.setInfraType === 'function') FM.setInfraType('kafka');
    else FM.setOverview(true); // 계약 문서에 setInfraType 미기재 — 안전 폴백
  }

  /* ───────── 렌더 빌딩블록 ───────── */

  function drawBreadcrumb(topicNode) {
    const bc = document.getElementById('breadcrumb');
    if (!bc) return;
    bc.style.display = 'flex';
    bc.innerHTML = '';
    const link = (text, fn) => {
      const s = document.createElement('span');
      s.className = 'bc-link';
      s.textContent = text;
      s.addEventListener('click', fn);
      return s;
    };
    const sep = () => {
      const s = document.createElement('span');
      s.className = 'bc-sep';
      s.textContent = '›';
      return s;
    };
    bc.appendChild(link('🗺️ 전체보기', () => FM.setOverview(true)));
    bc.appendChild(sep());
    bc.appendChild(link('📨 Kafka', goKafka));
    if (topicNode) {
      bc.appendChild(sep());
      const f = document.createElement('span');
      f.className = 'bc-focus';
      f.textContent = '📨 ' + topicLabel(topicNode);
      bc.appendChild(f);
    }
  }

  function emptyCard(text) {
    const el = document.createElement('div');
    el.className = 'node-card tpc-empty-card';
    el.textContent = text;
    return el;
  }

  // 서비스 그룹 박스 (.path-group 변형) — side: 'produce' | 'consume'
  function buildGroup(svc, ids, side) {
    const box = document.createElement('div');
    box.className = 'path-group tpc-group ' + (side === 'produce' ? 'tpc-produce' : 'tpc-consume');
    const head = document.createElement('div');
    head.className = 'pg-head';
    head.innerHTML =
      '<span class="tpc-chip ' + (side === 'produce' ? 'tpc-chip-produce' : 'tpc-chip-consume') + '">' +
      (side === 'produce' ? 'PRODUCE ⟶' : '⟶ CONSUME') + '</span>' +
      '<span class="tpc-svc">🧩 ' + FM.esc(svc) + '</span>' +
      '<span class="pg-count">' + ids.length + '</span>';
    box.appendChild(head);
    const body = document.createElement('div');
    body.className = 'pg-body';
    ids.forEach((id) => body.appendChild(FM.makeCard(id, {})));
    box.appendChild(body);
    return box;
  }

  // 2차 토픽 체인 미니 카드 — 클릭 시 그 토픽으로 재중심, 순환은 배지 표시 후 미전개
  function makeMiniTopic(tid, centerId, e2e) {
    const tn = FM.nodeById.get(tid);
    const name = tn ? topicLabel(tn) : String(tid).replace(/^kafka:/, '');
    const cyc = tid === centerId;
    const el = document.createElement('div');
    el.className = 'node-card tpc-mini' + (cyc ? ' tpc-cycle' : '');
    el.innerHTML =
      '<div class="tpc-mini-head"><span class="nc-icon">📨</span><span>' + FM.esc(name) + '</span>' +
      (cyc ? '<span class="tpc-badge-cycle">↺ 순환</span>' : '') + '</div>' +
      '<div class="tpc-mini-sub">' +
      (cyc ? '현재 분석 중인 토픽으로 되돌아옵니다' : '↳ 다음 토픽 — 클릭하여 재중심') +
      '</div>';
    if (!cyc) {
      el.addEventListener('click', () => recenter(tid, e2e));
      FM.cardEls.set(tid, el); // 커스텀 카드 커넥터 등록 (순환은 중앙 카드가 앵커)
    }
    return el;
  }

  /* ───────── 전체 토픽 목록 화면 ───────── */

  function renderList(missingId) {
    const cols = document.getElementById('columns');
    cols.className = 'tpc-view';
    cols.innerHTML = '';
    drawBreadcrumb(null);
    FM.setCanvasEdges([]);
    requestAnimationFrame(() => { FM.drawConnectors(); FM.applyHighlight(); });

    const topics = allTopics().sort((a, b) => topicLabel(a).localeCompare(topicLabel(b)));

    const bar = document.createElement('div');
    bar.className = 'tpc-bar';
    bar.innerHTML =
      '<span class="tpc-bar-title">📨 Kafka 토픽 목록</span>' +
      '<span class="grid-count">' + topics.length + '개 토픽</span>';
    cols.appendChild(bar);

    if (missingId) {
      const warn = document.createElement('p');
      warn.className = 'hint';
      warn.textContent = '요청한 토픽을 찾을 수 없습니다: ' + missingId;
      cols.appendChild(warn);
    }

    if (!topics.length) {
      const empty = document.createElement('div');
      empty.className = 'browse-empty';
      empty.innerHTML =
        '<div class="be-ico">📨</div>' +
        '<div class="be-msg">분석된 Kafka 토픽이 없습니다.</div>';
      cols.appendChild(empty);
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'tpc-list';
    topics.forEach((t) => {
      const p = produceEdgesOf(t.id).length;
      const c = consumeEdgesOf(t.id).length;
      const card = document.createElement('div');
      card.className = 'node-card tpc-topic-card' + (c === 0 ? ' tpc-dead' : '');
      card.innerHTML =
        '<div class="tpc-tc-name"><span class="nc-icon">📨</span>' + FM.esc(topicLabel(t)) + '</div>' +
        '<div class="tpc-tc-sub">producer ' + p + ' · consumer ' + c +
        (c === 0 ? ' <span class="tpc-dead-label">소비되지 않음</span>' : '') + '</div>';
      card.addEventListener('click', () => recenter(t.id, readE2e()));
      grid.appendChild(card);
    });
    cols.appendChild(grid);

    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = '토픽을 클릭하면 producer → 토픽 → consumer 영향도를 end-to-end 로 분석합니다.';
    cols.appendChild(hint);
  }

  /* ───────── 토픽 중심 뷰 ───────── */

  function renderTopic(topicNode, e2e) {
    const cols = document.getElementById('columns');
    cols.className = 'tpc-view';
    cols.innerHTML = '';
    drawBreadcrumb(topicNode);

    const maxDepth = e2e ? MAX_DEPTH : 1;
    const budget = { left: MAX_NODES - 1, truncated: false }; // 중앙 토픽 1개 선차감
    const prod = traceProduce(topicNode.id, maxDepth, budget);
    const cons = traceConsume(topicNode.id, maxDepth, budget);

    // 직접 producer/consumer 의 서비스 수
    const prodSvcs = new Set();
    produceEdgesOf(topicNode.id).forEach((e) => prodSvcs.add(projOf(e.source) || '(미지정)'));
    const consSvcs = new Set();
    consumeEdgesOf(topicNode.id).forEach((e) => consSvcs.add(projOf(e.target) || '(미지정)'));

    /* 분석 바 */
    const bar = document.createElement('div');
    bar.className = 'tpc-bar';

    const title = document.createElement('span');
    title.className = 'tpc-bar-title';
    title.textContent = '📨 ' + topicLabel(topicNode);
    bar.appendChild(title);

    const meta = document.createElement('span');
    meta.className = 'tpc-bar-meta';
    meta.textContent = 'producer ' + prodSvcs.size + ' 서비스 · consumer ' + consSvcs.size + ' 서비스';
    bar.appendChild(meta);

    const e2eLabel = document.createElement('label');
    e2eLabel.className = 'tpc-e2e';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = e2e;
    cb.addEventListener('change', () => recenter(topicNode.id, cb.checked));
    e2eLabel.appendChild(cb);
    e2eLabel.appendChild(document.createTextNode('엔드포인트까지 역추적(end-to-end)'));
    bar.appendChild(e2eLabel);

    if (budget.truncated) {
      const part = document.createElement('span');
      part.className = 'tpc-partial';
      part.textContent = '(일부만 표시)';
      bar.appendChild(part);
    }

    const back = document.createElement('span');
    back.className = 'bc-link tpc-back';
    back.textContent = '⟵ 토픽 목록';
    back.addEventListener('click', () => gotoList(e2e));
    bar.appendChild(back);

    cols.appendChild(bar);

    /* 3컬럼: PRODUCE ⟶ │ 토픽 │ ⟶ CONSUME */
    const row = document.createElement('div');
    row.className = 'tpc-cols';

    // 왼쪽 — produce 측
    const colP = document.createElement('div');
    colP.className = 'column tpc-col-produce';
    colP.appendChild(FM.mkHead('PRODUCE 측 — 발행 경로'));
    const prodGroups = groupBySvc(prod, true); // 엔드포인트(깊은 단계)부터
    if (!prodGroups.size) {
      colP.appendChild(emptyCard('분석 범위 밖 producer 가능성'));
    } else {
      prodGroups.forEach((ids, svc) => colP.appendChild(buildGroup(svc, ids, 'produce')));
    }
    row.appendChild(colP);

    // 중앙 — 토픽 카드 (1.25배 확대)
    const colC = document.createElement('div');
    colC.className = 'column tpc-col-center';
    colC.appendChild(FM.mkHead('📨 토픽'));
    const wrap = document.createElement('div');
    wrap.className = 'tpc-center-wrap';
    const centerCard = FM.makeCard(topicNode.id, {});
    centerCard.classList.add('tpc-center');
    wrap.appendChild(centerCard);
    colC.appendChild(wrap);
    row.appendChild(colC);

    // 오른쪽 — consume 측 (+ 2차 토픽 미니 카드)
    const colK = document.createElement('div');
    colK.className = 'column tpc-col-consume';
    colK.appendChild(FM.mkHead('CONSUME 측 — 소비 경로'));
    const consGroups = groupBySvc(cons, false); // 리스너(가까운 단계)부터
    const miniIds = new Set();
    if (!consGroups.size) {
      colK.appendChild(emptyCard('컨슈머 없음 — 이 이벤트는 소비되지 않습니다'));
    } else {
      consGroups.forEach((ids, svc) => {
        const box = buildGroup(svc, ids, 'consume');
        const body = box.querySelector('.pg-body');
        cons.nextTopics.forEach((svcSet, tid) => { // 이 서비스가 발행하는 다음 토픽
          if (!svcSet.has(svc)) return;
          body.appendChild(makeMiniTopic(tid, topicNode.id, e2e));
          if (tid !== topicNode.id) miniIds.add(tid);
        });
        colK.appendChild(box);
      });
    }
    row.appendChild(colK);
    cols.appendChild(row);

    /* 커넥터: 활성 노드 집합 사이의 엣지만 등록 */
    const active = new Set([topicNode.id]);
    prod.depth.forEach((_d, id) => active.add(id));
    cons.depth.forEach((_d, id) => active.add(id));
    miniIds.forEach((id) => active.add(id));
    const edges = FM.EDGES.filter((e) => active.has(e.source) && active.has(e.target));
    FM.setCanvasEdges(edges);
    requestAnimationFrame(() => { FM.drawConnectors(); FM.applyHighlight(); });
  }

  /* ───────── 뷰 등록 ───────── */

  function render() {
    const topicId = FM.param('topic'); // URL 이 단일 진실 — 항상 파라미터에서 복원
    const e2e = readE2e();
    const node = topicId ? FM.nodeById.get(topicId) : null;
    if (!node || !isTopicNode(node)) {
      renderList(topicId || '');
      return;
    }
    renderTopic(node, e2e);
  }

  FM.registerView('topic', {
    render,
    escape() { goKafka(); },
  });
})();
