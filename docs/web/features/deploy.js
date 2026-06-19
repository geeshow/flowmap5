// features/deploy.js — 배포 영향도: 좌측 레일(일자 그룹 → 배포목록) + 우측 풀폭 영향도.
//   커밋 영향도(impact.js) 구성과 유사: 레일에서 배포를 고르면 오른쪽에 PR 목록 + 서비스 영향도를 넓게.
//   진입 시 첫 배포·첫 PR 이 기본 선택된다. PR 클릭 → 커밋 영향도 뷰로 이동하지 않고,
//   impact.js 의 공개 컴포넌트(FM.impact.renderInto)로 동일한 영향도 콘텐츠를 하단에 임베드.
// URL: view=deploy, y=<년도>, d=<날짜>, t=<티켓id>, pr=<PR번호>
(function () {
  const FM = window.Flowmap;
  const BASE = 'data/deploy/';
  const DOW = ['일', '월', '화', '수', '목', '금', '토'];
  // 배포 티켓 상태(ticket_step) — 하위 메뉴/탭 분리 기준
  const STATUS_ORDER = ['request', 'approved', 'done', 'cancel'];
  const STATUS_LABEL = { request: '요청', approved: '승인', done: '완료', cancel: '취소' };
  function normStatus(step) {
    const s = String(step || '').toLowerCase();
    if (s === 'cancel' || s === 'canceled' || s === 'cancelled') return 'cancel';
    return STATUS_LABEL[s] ? s : s;   // 알 수 없는 값은 원문 유지(전체에만 노출)
  }
  function curStatus() { const s = FM.param('st'); return STATUS_ORDER.includes(s) ? s : null; }
  function filterByStatus(byDate, st) {
    if (!st) return byDate;
    const m = new Map();
    for (const [date, grp] of byDate) {
      const tickets = grp.tickets.filter((t) => t.status === st);
      if (tickets.length) m.set(date, Object.assign({}, grp, { tickets }));
    }
    return m;
  }
  function statusCounts(byDate) {
    const c = { all: 0 }; for (const s of STATUS_ORDER) c[s] = 0;
    for (const [, grp] of byDate) for (const t of grp.tickets) { c.all++; if (c[t.status] != null) c[t.status]++; }
    return c;
  }

  let indexData;                 // undefined=미로드, null=데이터없음, {byDate,years,year}
  const dayCache = new Map();    // date → Promise<{deploy, pr}>
  const yearCache = new Map();   // year → Promise<Map<date,{date,rec,tickets}>>
  let renderSeq = 0;
  let railFilter = '';           // 레일 텍스트 필터(담당자/요약/서비스/#ID) — 재렌더 간 유지
  let svcHop = 1;                // 서비스 영향도 연관관계 표시 단계 — 기본 1차(배포 서비스에 직접 연결된 서비스만)

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }
  function serviceHue(name) {
    let h = 2166136261;
    for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0) % 360;
  }
  function dow(date) { const d = new Date(date + 'T00:00:00'); return isNaN(d) ? '' : DOW[d.getDay()]; }
  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso); if (isNaN(d)) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /* ───────── 데이터 로드 ───────── */
  async function ensureIndex() {
    if (indexData !== undefined) return indexData;
    const [idx, pidx] = await Promise.all([FM.fetchData(BASE + 'index.json'), FM.fetchData(BASE + 'pr_index.json')]);
    if (!idx && !pidx) { indexData = null; return null; }
    const byDate = new Map();
    for (const q of (idx && idx.queries) || []) byDate.set(q.date, { date: q.date, deployCount: q.deployCount || 0, deployStatus: q.status, deployFile: q.file, prCount: 0, ticketCount: 0 });
    for (const e of (pidx && pidx.entries) || []) {
      const r = byDate.get(e.date) || { date: e.date, deployCount: 0 };
      r.prCount = e.prCount || 0; r.ticketCount = e.ticketCount || 0; r.prStatus = e.status; r.prFile = e.file;
      byDate.set(e.date, r);
    }
    const years = [...new Set([...byDate.keys()].map((d) => d.slice(0, 4)))].sort().reverse();
    indexData = { byDate, years, year: (idx && idx.year) || (pidx && pidx.year) || (years[0] ? +years[0] : null) };
    return indexData;
  }
  function loadDay(rec) {
    if (dayCache.has(rec.date)) return dayCache.get(rec.date);
    const p = Promise.all([
      rec.deployFile ? FM.fetchData(BASE + rec.deployFile) : Promise.resolve(null),
      rec.prFile ? FM.fetchData(BASE + rec.prFile) : Promise.resolve(null),
    ]).then(([deploy, pr]) => ({ deploy, pr }));
    dayCache.set(rec.date, p);
    return p;
  }
  // 선택 년도의 모든(배포 있는) 날짜를 로드해 일자별 티켓 목록 구성 (레일 그룹용)
  function loadYear(year) {
    if (yearCache.has(year)) return yearCache.get(year);
    const recs = [...indexData.byDate.values()].filter((r) => r.date.slice(0, 4) === year && ((r.deployCount || 0) > 0 || (r.prCount || 0) > 0));
    const projs = serviceIndex();
    const p = Promise.all(recs.map((r) => loadDay(r).then(({ deploy, pr }) => ({ date: r.date, rec: r, tickets: buildTickets(deploy, pr, projs) }))))
      .then((arr) => { arr.sort((a, b) => b.date.localeCompare(a.date)); const m = new Map(); for (const x of arr) if (x.tickets.length) m.set(x.date, x); return m; });
    yearCache.set(year, p);
    return p;
  }

  /* ───────── 서비스 매핑 ───────── */
  // names: 모든 프로젝트명(정확매칭용). byRepo: git 저장소 식별자 → 그 repo의 대표 서비스.
  // 모노레포는 sub-root가 여러 프로젝트(`my-mono-packages-*`)로 쪼개지지만 매니페스트의 `repo`
  // 필드(분석기가 찍는 git 저장소명, 예 `my-mono`)가 같으므로, 배포의 git_repository 를 그 repo의
  // 대표 서비스(impact 보유분 우선)로 매핑한다 — 그래서 모노레포 배포도 "미매핑"이 되지 않는다.
  function serviceIndex() {
    const names = new Set((FM.META && FM.META.projects) || []);
    const byRepo = new Map();
    for (const p of (FM.MANIFEST && FM.MANIFEST.projects) || []) {
      if (!p || !p.name) continue;
      names.add(p.name);
      if (p.repo && (!byRepo.has(p.repo) || p.impact)) byRepo.set(p.repo, p.name); // impact 보유 서비스 우선
    }
    return { names, byRepo };
  }
  function mapRepoToService(repo, projectName, idx) {
    if (repo && idx.names.has(repo)) return repo;             // 단일 repo=서비스 정확매칭
    if (projectName && idx.names.has(projectName)) return projectName;
    if (repo && idx.byRepo.has(repo)) return idx.byRepo.get(repo); // 모노레포: repo → 대표 서비스
    return null;
  }
  // 모노레포 repo 의 "그래프 보유 모듈 서비스" 목록 (manifest.repo 마커 기반).
  //   tera-terafi 처럼 graph 없는 repo 엔트리(=repo 단위 pulls/impact 보유) 자신은 제외하고,
  //   trf-credit·trf-loan 같은 모듈만 돌려준다. 단일 repo(모듈 없음)면 빈 배열.
  function modulesOfRepo(repo) {
    if (!repo) return [];
    return (FM.MANIFEST && FM.MANIFEST.projects || [])
      .filter((p) => p && p.graph && p.repo === repo && p.name !== repo)
      .map((p) => p.name);
  }
  // 배포가 건드린(touched) 서비스 집합 — 모노레포면 모듈 서비스 전체, 아니면 대표 서비스 하나.
  //   서비스 영향도 연관관계 그래프는 이 집합을 기준으로 그린다(그래프 없는 repo 엔트리는 제외돼야
  //   빈 카드/연결 0 문제가 안 생긴다). pulls/impact 조회는 별도로 tk.service(대표=repo 엔트리)를 쓴다.
  function touchedServicesFor(tk) {
    const mods = modulesOfRepo(tk.repo);
    if (mods.length) return new Set(mods);
    return tk.service ? new Set([tk.service]) : new Set();
  }
  function buildTickets(deploy, pr, projs) {
    const deployList = (deploy && deploy.deploy_list) || [];
    const depByTicket = new Map(deployList.map((d) => [d.release_ticket_id, d]));
    const tickets = []; const seen = new Set();
    const model = (t, dep) => {
      const cat = (dep && dep.catalog_project) || {};
      const org = (t && t.git_organization) || cat.git_organization || '';
      const repo = (t && t.git_repository) || cat.git_repository || '';
      const projectName = cat.project_name || '';
      return {
        id: (t && t.release_ticket_id) || (dep && dep.release_ticket_id),
        summary: (t && t.summary) || (dep && dep.summary) || '(제목 없음)',
        phase: (t && t.phase) || (dep && dep.phase) || '',
        platform: (t && t.platform) || (dep && dep.platform) || '',
        releaseAt: (t && t.release_at) || (dep && dep.release_at) || '',
        createdBy: (dep && dep.created_by) || (t && t.created_by) || '',   // 배포 담당자(요청/생성자)
        approvedBy: (dep && dep.approved_by) || '',
        verifier: (dep && dep.verifier) || '',
        monitorBy: (dep && dep.monitor_by) || '',
        businessMonitorBy: (dep && dep.business_monitor_by) || '',
        org, repo, projectName,
        status: normStatus((dep && dep.ticket_step) || (t && t.ticket_step)),
        prs: (t && t.prs) || [],
        service: mapRepoToService(repo, projectName, projs),
      };
    };
    for (const t of (pr && pr.by_ticket) || []) { seen.add(t.release_ticket_id); tickets.push(model(t, depByTicket.get(t.release_ticket_id))); }
    for (const d of deployList) { if (!seen.has(d.release_ticket_id)) tickets.push(model(null, d)); }
    return tickets;
  }
  function serviceEdges() {
    const agg = new Map();
    for (const e of FM.EDGES) {
      if (e.kind !== 's2s' && e.kind !== 'join') continue;
      const sn = FM.nodeById.get(e.source), tn = FM.nodeById.get(e.target);
      if (!sn || !tn) continue;
      const sp = sn.project, tp = tn.project;
      if (!sp || !tp || sp === tp) continue;
      const kc = e.kind === 's2s' ? 's2s' : 'join';
      const key = sp + '|' + tp + '|' + kc;
      let a = agg.get(key);
      if (!a) { a = { source: 'svc:' + sp, target: 'svc:' + tp, sp, tp, kc, count: 0, async: false }; agg.set(key, a); }
      a.count++; if (e.mode === 'async') a.async = true;
    }
    return [...agg.values()];
  }

  /* ───────── 뷰 ───────── */
  function curYear() {
    const y = FM.param('y');
    if (y) return y;
    if (indexData && indexData.year != null) return String(indexData.year);
    return (indexData && indexData.years[0]) || '';
  }
  // 선택 년도에서 데이터(배포/PR)가 있는 월 목록 (최신순, '01'~'12').
  function monthsOf(year) {
    const s = new Set();
    if (indexData) for (const r of indexData.byDate.values())
      if (r.date.slice(0, 4) === year && ((r.deployCount || 0) > 0 || (r.prCount || 0) > 0)) s.add(r.date.slice(5, 7));
    return [...s].sort().reverse();
  }
  // 현재 월: d 파라미터(딥링크) > m 파라미터 > 오늘 월(현재 년도일 때) > 해당 년도 최신 월.
  function curMonth() {
    const d = FM.param('d');
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d.slice(5, 7);
    const m = FM.param('m');
    if (m && /^\d{2}$/.test(m)) return m;
    const y = curYear();
    const months = monthsOf(y);
    const now = new Date();
    const tm = String(now.getMonth() + 1).padStart(2, '0');
    if (y === String(now.getFullYear()) && (months.includes(tm) || !months.length)) return tm;
    return months[0] || tm;
  }
  // 일반 이동은 현재 상태(st)를 유지. 상태 탭/하위메뉴는 st 를 명시(전체='')해 덮어쓴다.
  function nav(params) {
    if (!('st' in params)) { const st = curStatus(); if (st) params = Object.assign({ st }, params); }
    FM.pushViewUrl('deploy', params); render();
  }

  // URL 파라미터(d/t/pr)가 있으면 그대로, 없으면 기본값(첫 배포일·첫 배포·첫 PR)을 채운 "유효 선택".
  // 배포 영향도 진입 시 URL 을 더럽히지 않고도 첫 배포·첫 PR 이 선택된 상태로 보이게 한다.
  function computeEffective(byDate) {
    let date = FM.param('d'), ticketId = FM.param('t'), prNumber = FM.param('pr');
    if (!date || !byDate.has(date)) date = byDate.size ? byDate.keys().next().value : null;
    const grp = date && byDate.get(date);
    const tickets = (grp && grp.tickets) || [];
    let ticket = ticketId && tickets.find((x) => String(x.id) === ticketId);
    if (!ticket && tickets.length) ticket = tickets[0];
    ticketId = ticket ? String(ticket.id) : null;
    if (ticket) {
      const prs = ticket.prs || [];
      let pr = (prNumber != null) && prs.find((p) => String(p.number) === String(prNumber));
      if (!pr && prs.length) pr = prs[0];
      prNumber = pr ? String(pr.number) : null;
    } else prNumber = null;
    return { date, ticketId, prNumber, ticket };
  }

  FM.registerView('deploy', {
    render,
    escape() { if (FM.param('t')) nav({ y: curYear(), m: curMonth() }); else FM.setOverview(true); },
  });

  function render() {
    const seq = ++renderSeq;
    const cols = document.getElementById('columns');
    if (indexData === undefined) {
      cols.className = 'dep-view'; cols.innerHTML = '<div class="dep-loading">불러오는 중…</div>';
      ensureIndex().then(() => { if (renderSeq === seq) afterIndex(seq); });
      return;
    }
    afterIndex(seq);
  }

  function drawBreadcrumb(eff) {
    const bc = document.getElementById('breadcrumb');
    if (!bc) return;
    bc.style.display = 'flex';
    const y = curYear(), m = curMonth();
    const d = eff ? eff.date : FM.param('d'), t = eff ? eff.ticketId : FM.param('t');
    const pr = eff ? eff.prNumber : FM.param('pr');
    const seg = [`<span class="bc-link" data-dep="root">🚀 배포 영향도</span>`];
    if (indexData && indexData.years.length) {
      seg.push(`<span class="bc-sep">›</span><span class="bc-link" data-dep="year">${FM.esc(y)}년</span>`);
      seg.push(`<span class="bc-sep">›</span><span class="bc-link" data-dep="month">${+m}월</span>`);
    }
    const st = curStatus();
    if (st) seg.push(`<span class="bc-sep">›</span><span class="bc-link" data-dep="status">${FM.esc(STATUS_LABEL[st])}</span>`);
    if (d && t) seg.push(`<span class="bc-sep">›</span><span class="bc-focus">${FM.esc(d)} #${FM.esc(t)}${pr != null && pr !== '' ? ` · PR #${FM.esc(String(pr))}` : ''}</span>`);
    bc.innerHTML = seg.join('');
    bc.querySelector('[data-dep="root"]').onclick = () => nav({ y, st: '' });
    bc.querySelector('[data-dep="year"]') && (bc.querySelector('[data-dep="year"]').onclick = () => nav({ y }));
    bc.querySelector('[data-dep="month"]') && (bc.querySelector('[data-dep="month"]').onclick = () => nav({ y, m }));
    bc.querySelector('[data-dep="status"]') && (bc.querySelector('[data-dep="status"]').onclick = () => nav({ y, m, st }));
  }

  function afterIndex(seq) {
    const cols = document.getElementById('columns');
    cols.className = 'dep-view'; cols.innerHTML = '';
    FM.setCanvasEdges([]); FM.cardEls.clear();
    document.getElementById('connectors').innerHTML = '';
    drawBreadcrumb();
    if (indexData === null) { renderMissing(cols); return; }

    const rail = el('div', 'dep-rail');
    const main = el('div', 'dep-main');
    cols.append(rail, main);
    // dep-main 세로 스크롤 시 커넥터(서비스/임베드 임팩트 그래프) 위치 재계산.
    let scrollRaf = 0;
    main.addEventListener('scroll', () => {
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; FM.drawConnectors(); });
    });
    attachStickyHScroll(main);
    rail.innerHTML = '<div class="dep-loading">불러오는 중…</div>';
    main.innerHTML = '';
    loadYear(curYear()).then((byDate) => {
      if (renderSeq !== seq) return;
      const m = curMonth();
      const monthByDate = new Map([...byDate].filter(([date]) => date.slice(5, 7) === m));
      const counts = statusCounts(monthByDate);              // 상태 탭 배지(필터 전 기준)
      const shownByDate = filterByStatus(monthByDate, curStatus());
      const eff = computeEffective(shownByDate);
      drawBreadcrumb(eff);
      renderRail(rail, shownByDate, eff, counts);
      renderMain(main, shownByDate, eff, seq);
    });
  }

  function renderMissing(cols) {
    const box = el('div', 'browse-empty dep-empty',
      '<div class="be-ico">🚀</div>' +
      '<div class="be-msg">배포 영향도 데이터가 없습니다<br>' +
      '<span class="hint"><code>docs/web/data/deploy/</code> 에 <code>index.json</code> · <code>pr_index.json</code> ·' +
      ' <code>&lt;년도&gt;/&lt;날짜&gt;/deploy_list.json</code> · <code>pr_list.json</code> 을 넣은 뒤 새로고침하세요.</span></div>' +
      '<div class="be-actions"><button class="btn" data-dep-home>🗺️ 전체보기로</button></div>');
    box.querySelector('[data-dep-home]').onclick = () => FM.setOverview(true);
    cols.appendChild(box);
  }

  /* ───────── 좌측 레일: 일자 그룹 → 배포목록 ───────── */
  function renderRail(rail, byDate, eff, counts) {
    const y = curYear(), m = curMonth(), curD = eff ? eff.date : FM.param('d'), curT = eff ? eff.ticketId : FM.param('t');
    rail.innerHTML = '';
    const head = el('div', 'dep-rail-head');
    head.appendChild(el('span', 'dep-rail-title', '🚀 배포'));
    const picks = el('div', 'dep-picks');
    const sel = el('select', 'dep-year');
    for (const yr of indexData.years) { const o = el('option'); o.value = yr; o.textContent = yr + '년'; if (yr === y) o.selected = true; sel.appendChild(o); }
    sel.onchange = () => nav({ y: sel.value });   // 년도 변경 → 월 기본값 재계산
    picks.appendChild(sel);
    const msel = el('select', 'dep-month');
    const months = monthsOf(y);
    if (!months.includes(m)) { months.push(m); months.sort().reverse(); }   // 현재 선택 월이 데이터 없어도 노출
    for (const mo of months) { const o = el('option'); o.value = mo; o.textContent = (+mo) + '월'; if (mo === m) o.selected = true; msel.appendChild(o); }
    msel.onchange = () => nav({ y, m: msel.value });
    picks.appendChild(msel);
    head.appendChild(picks);
    rail.appendChild(head);

    // 상태 탭(전체/요청/승인/완료/취소) — 클릭 시 st 로 필터. 데이터 없어도 항상 노출.
    const st = curStatus();
    const cnt = counts || { all: 0 };
    const tabs = el('div', 'dep-status-tabs');
    const mkTab = (key, label) => {
      const n = key === 'all' ? (cnt.all || 0) : (cnt[key] || 0);
      const b = el('button', 'dep-stab st-' + key + ((key === 'all' ? !st : st === key) ? ' on' : ''));
      b.innerHTML = `${FM.esc(label)}<span class="dep-stab-n">${n}</span>`;
      b.onclick = () => nav({ y, m, st: key === 'all' ? '' : key });
      return b;
    };
    tabs.appendChild(mkTab('all', '전체'));
    for (const k of STATUS_ORDER) tabs.appendChild(mkTab(k, STATUS_LABEL[k]));
    rail.appendChild(tabs);

    // 텍스트 필터(담당자/요약/서비스/#ID/PR제목)
    const filter = el('input', 'dep-filter');
    filter.type = 'text';
    filter.placeholder = '담당자 / 요약 / 서비스 / #ID 필터…';
    filter.value = railFilter;
    rail.appendChild(filter);
    const empty = el('div', 'dep-rail-empty', '일치하는 배포가 없습니다');
    empty.style.display = 'none';
    rail.appendChild(empty);

    if (!byDate.size) { rail.appendChild(el('div', 'dep-hint', st ? `이 달 '${STATUS_LABEL[st]}' 상태 배포가 없습니다.` : '이 달 배포 데이터가 없습니다.')); return; }
    for (const [date, grp] of byDate) {
      const g = el('div', 'dep-dgroup');
      g.dataset.date = date;                       // 스크롤 힌트가 현재 영역 날짜 식별용
      g.appendChild(el('div', 'dep-dg-head',
        `<span class="dep-dg-date">${FM.esc(date)}</span><span class="dep-dg-dow">${dow(date)}</span>`));
      for (const t of grp.tickets) {
        const on = date === curD && String(t.id) === curT;
        const row = el('div', 'dep-ditem' + (on ? ' sel' : ''));
        row.dataset.search = [t.id, t.summary, t.service, t.platform, t.createdBy, ...(t.prs || []).map((p) => p.title)]
          .filter(Boolean).join(' ').toLowerCase();
        const svc = t.service ? `<span class="dep-svc-tag ok">🔗${FM.esc(t.service)}</span>` : (t.repo ? `<span class="dep-svc-tag no">미매핑</span>` : '');
        const tWarn = (t.prs || []).some((p) => !p.merged_at) ? '<span class="dep-di-warn" title="Has un-merged PR(s)">⚠️</span>' : '';
        row.innerHTML =
          `<div class="dep-di-top"><span class="dep-di-id">#${FM.esc(String(t.id || ''))}</span><span class="dep-di-pr">${tWarn}🔀${t.prs.length}</span></div>` +
          `<div class="dep-di-summary">${FM.esc(t.summary)}</div>` +
          `<div class="dep-di-meta">${t.platform ? `<span class="dep-chip">${FM.esc(t.platform)}</span>` : ''}${svc}` +
          `${t.createdBy ? `<span class="dep-by">👤 ${FM.esc(t.createdBy)}</span>` : ''}</div>`;
        row.onclick = () => nav({ y, d: date, t: String(t.id) });
        g.appendChild(row);
      }
      rail.appendChild(g);
    }

    // 필터 적용 — 일치하는 항목만 표시하고, 보이는 항목이 없는 날짜 그룹은 숨긴다.
    const applyFilter = () => {
      const q = railFilter.trim().toLowerCase();
      let shown = 0;
      rail.querySelectorAll('.dep-dgroup').forEach((g) => {
        let groupShown = 0;
        g.querySelectorAll('.dep-ditem').forEach((row) => {
          const hit = !q || (row.dataset.search || '').includes(q);
          row.style.display = hit ? '' : 'none';
          if (hit) { groupShown++; shown++; }
        });
        g.style.display = groupShown ? '' : 'none';
      });
      empty.style.display = shown ? 'none' : '';
    };
    filter.oninput = () => { railFilter = filter.value; applyFilter(); };
    applyFilter();

    // 스크롤 위치 날짜 힌트: 빠르게 스크롤할 때 현재 영역의 날짜를 잠깐 띄웠다가 사라지게 한다.
    const groups = [...rail.querySelectorAll('.dep-dgroup')];
    if (groups.length) {
      const hint = el('div', 'dep-scroll-hint');
      const pill = el('span', 'dep-sh-pill');
      hint.appendChild(pill);
      rail.parentNode.appendChild(hint);           // 레일이 아닌 패널(.dep-view)에 얹어 스크롤과 무관하게 고정
      let hideT = 0;
      rail.addEventListener('scroll', () => {
        const railTop = rail.getBoundingClientRect().top;
        let cur = groups[0];                         // 헤더가 레일 상단(≈14px)에 닿은 마지막 그룹 = 현재 영역
        for (const g of groups) { if (g.getBoundingClientRect().top - railTop <= 14) cur = g; else break; }
        const dt = cur && cur.dataset.date;
        if (!dt) return;
        pill.textContent = `${dt} (${dow(dt)})`;
        hint.classList.add('show');
        clearTimeout(hideT);
        hideT = setTimeout(() => hint.classList.remove('show'), 700);
      });
    }
  }

  /* ───────── 우측 메인: 선택 배포의 PR 목록 + 서비스 영향도 (풀폭) ───────── */
  function renderMain(main, byDate, eff, seq) {
    main.innerHTML = '';
    const y = curYear();
    const d = eff && eff.date, tk = eff && eff.ticket;
    if (!tk) {
      main.appendChild(el('div', 'dep-main-empty',
        '<div class="dme-ico">🚀</div><div class="dme-msg">왼쪽에서 배포를 선택하세요</div>'));
      return;
    }

    const head = el('div', 'dep-main-head');
    const repo = (tk.org ? tk.org + '/' : '') + (tk.repo || '');
    // 상세 담당자 전체 노출(요청/승인/검증/모니터링/비즈니스 모니터링) — 값 있는 역할만.
    const roles = [
      ['요청', tk.createdBy], ['승인', tk.approvedBy], ['검증', tk.verifier],
      ['모니터링', tk.monitorBy], ['비즈니스 모니터링', tk.businessMonitorBy],
    ];
    const peopleHtml = roles.filter(([, v]) => v)
      .map(([role, v]) => `<span class="dep-person"><span class="dep-person-role">${role}</span>${FM.esc(String(v).replace(/,/g, ', '))}</span>`)
      .join('');
    head.innerHTML =
      `<div class="dep-mh-top"><span class="dep-mh-id">#${FM.esc(String(tk.id))}</span>` +
      `<span class="dep-mh-time">${FM.esc(d)} · ${FM.esc(fmtTime(tk.releaseAt))}</span></div>` +
      `<div class="dep-mh-summary">${FM.esc(tk.summary)}</div>` +
      `<div class="dep-mh-meta">${tk.platform ? `<span class="dep-chip">${FM.esc(tk.platform)}</span>` : ''}` +
      `${tk.phase ? `<span class="dep-chip">${FM.esc(tk.phase)}</span>` : ''}` +
      `${repo ? `<span class="dep-repo">${FM.esc(repo)}</span>` : ''}` +
      `${tk.service ? `<span class="dep-svc-tag ok">🔗${FM.esc(tk.service)}</span>` : (tk.repo ? `<span class="dep-svc-tag no">그래프 미매핑</span>` : '')}</div>` +
      (peopleHtml ? `<div class="dep-mh-people">${peopleHtml}</div>` : '');
    main.appendChild(head);

    // PR 목록
    const prSec = el('div', 'dep-section');
    const unmergedCount = (tk.prs || []).filter((p) => !p.merged_at).length;
    prSec.appendChild(el('div', 'dep-sec-head', `PR 목록 (${tk.prs.length})` +
      (unmergedCount ? ` <span class="dep-sec-warn" title="${unmergedCount} un-merged PR(s)">⚠️ Unmerged ${unmergedCount}</span>` : '')));
    if (!tk.prs.length) prSec.appendChild(el('div', 'dep-hint', '연결된 PR이 없습니다.'));
    else {
      const list = el('div', 'dep-pr-grid');
      const ctx = { y, d, t: eff.ticketId, sel: eff.prNumber };
      for (const p of tk.prs) list.appendChild(prCard(p, ctx));
      prSec.appendChild(list);
    }
    main.appendChild(prSec);

    // 서비스 영향도 (풀폭) — 서비스 단위 연관관계
    const impSec = el('div', 'dep-section');
    impSec.appendChild(el('div', 'dep-sec-head', '서비스 영향도 · 연관관계'));
    if (!tk.service) {
      impSec.appendChild(el('div', 'dep-imp-note',
        `이 배포(<code>${FM.esc(repo)}</code>)는 분석 그래프에 매칭되는 서비스가 없습니다. 메서드 단위 영향은 아래 “PR 커밋 영향도”에서 확인하세요.`));
    } else {
      const wrap = el('div', 'dep-svc-graph');
      impSec.appendChild(wrap);
      renderServiceGraph(wrap, touchedServicesFor(tk));   // 모노레포면 모듈 서비스 전체를 기준으로
    }
    main.appendChild(impSec);

    // PR 커밋 영향도 (하단 임베드) — 커밋 영향도 뷰로 이동하지 않고 같은 콘텐츠를 여기서 렌더.
    renderPrImpact(main, eff, seq);
    // 변경 파일 + 변경 전후 코드(diff) — 배포 영향도가 있어도 항상 하단에 노출.
    renderPrFiles(main, eff, seq);
  }

  // 선택 PR 의 변경 파일 목록 + 변경 전/후 코드(unified diff)를 하단에 노출.
  //   데이터: <project>.pulls 인덱스 → <project>.pulls/<번호>.json 샤드(files[].patch).
  function pullsRelFor(tk) {
    const cands = [tk && tk.service, tk && tk.repo, tk && tk.projectName].filter(Boolean);
    for (const p of (FM.MANIFEST && FM.MANIFEST.projects) || [])
      if (p && p.pulls && cands.includes(p.name)) return p.pulls;
    return null;
  }
  function renderPatch(patch) {
    if (!patch) return '<div class="dep-dl ctx">(diff 없음 — 바이너리이거나 너무 큰 파일)</div>';
    return patch.split('\n').map((l) => {
      const c = l.charAt(0);
      const cls = c === '+' ? 'add' : c === '-' ? 'del' : c === '@' ? 'hunk' : 'ctx';
      return `<div class="dep-dl ${cls}">${FM.esc(l) || '&nbsp;'}</div>`;
    }).join('');
  }
  function fileRow(f, openByDefault) {
    const row = el('div', 'dep-file' + (openByDefault ? ' open' : ''));
    const st = f.status || 'modified';
    const path = f.path || f.previousPath || '';
    const renamed = f.previousPath && f.previousPath !== f.path ? `${FM.esc(f.previousPath)} → ` : '';
    const head = el('div', 'dep-file-head',
      `<span class="dep-file-st ${FM.esc(st)}">${FM.esc(st)}</span>` +
      `<code class="dep-file-path">${renamed}${FM.esc(path)}</code>` +
      `<span class="dep-file-stat"><span class="add">+${f.additions || 0}</span> <span class="del">−${f.deletions || 0}</span></span>` +
      `<span class="dep-file-tog">▾</span>`);
    const body = el('div', 'dep-diff');
    let built = false;
    const build = () => { if (!built) { body.innerHTML = renderPatch(f.patch); built = true; } };
    if (openByDefault) build();
    head.onclick = () => { if (row.classList.toggle('open')) build(); };
    row.append(head, body);
    return row;
  }
  function renderPrFiles(main, eff, seq) {
    if (!eff || eff.prNumber == null) return;
    const pullsRel = pullsRelFor(eff.ticket);
    const sec = el('div', 'dep-section dep-files');
    sec.appendChild(el('div', 'dep-sec-head', `PR #${FM.esc(String(eff.prNumber))} 변경 파일`));
    const host = el('div', 'dep-files-host');
    host.innerHTML = '<div class="dep-loading">변경 파일 불러오는 중…</div>';
    sec.appendChild(host);
    main.appendChild(sec);
    if (!pullsRel) { host.innerHTML = '<div class="dep-hint">이 PR의 변경 파일 데이터(pulls)가 없습니다.</div>'; return; }
    const baseDir = 'data/' + pullsRel.replace(/[^/]*$/, '');   // 'data/projects/<proj>/'
    FM.fetchData('data/' + pullsRel)
      .then((idx) => {
        if (renderSeq !== seq) return;
        const entry = idx && (idx.pulls || []).find((p) => String(p.number) === String(eff.prNumber));
        if (!entry) { host.innerHTML = '<div class="dep-hint">이 PR이 변경 파일 인덱스에 없습니다.</div>'; return; }
        return FM.fetchData(baseDir + entry.file).then((shard) => {
          if (renderSeq !== seq) return;
          const files = (shard && shard.files) || [];
          if (!files.length) { host.innerHTML = '<div class="dep-hint">변경 파일이 없습니다.</div>'; return; }
          host.innerHTML = '';
          host.appendChild(el('div', 'dep-files-sub', `${files.length}개 파일 · 클릭하면 변경 전/후 코드(diff)`));
          files.forEach((f, i) => host.appendChild(fileRow(f, i < 3)));   // 앞 3개는 기본 펼침
        });
      })
      .catch(() => { host.innerHTML = '<div class="dep-hint">변경 파일 로드 실패.</div>'; });
  }

  // 선택된 PR 의 커밋 영향도(분석 바 + 경계 투영 그래프)를 하단에 임베드한다.
  // impact.js 의 공개 API(FM.impact.renderInto)를 재사용 — 커밋 영향도 뷰와 동일한 컴포넌트.
  function renderPrImpact(main, eff, seq) {
    if (!eff || eff.prNumber == null) return;
    const sec = el('div', 'dep-section dep-impact');
    sec.appendChild(el('div', 'dep-sec-head', `PR #${FM.esc(String(eff.prNumber))} 커밋 영향도`));
    const host = el('div', 'dep-impact-host');
    host.innerHTML = '<div class="dep-loading">커밋 영향도 불러오는 중…</div>';
    sec.appendChild(host);
    main.appendChild(sec);
    FM.loadFeature('impact')
      .then(() => FM.impact && FM.impact.ensure())   // 커밋 인덱스 로드(commitBySha 채움) — prKey 조회 전 필수
      .then(() => {
        if (renderSeq !== seq) return;                  // 그 사이 다른 배포/PR로 재렌더됨
        const key = FM.impact && FM.impact.prKey(eff.prNumber);
        if (!key) { host.innerHTML = '<div class="dep-hint">이 PR의 커밋 영향도 데이터가 없습니다 (impact 미수집).</div>'; return; }
        FM.impact.renderInto(host, [key]);
      }).catch(() => { host.innerHTML = '<div class="dep-hint">커밋 영향도 모듈 로드 실패.</div>'; });
  }

  // 임베드 영향 그래프(.imp-gwrap)의 가로 스크롤바를 dep-main 하단에 sticky 로 고정한다.
  // 그래프 블록이 길어 세로로 한참 내려야 닿던 가로 스크롤을, 세로 위치와 무관하게 패널
  // 하단에서 항상 잡게 만든다. .imp-gwrap 의 자체 scroll 핸들러가 커넥터를 다시 그리므로
  // 여기서는 scrollLeft 만 양방향 동기화한다(폭 차이는 비율 매핑으로 보정).
  function attachStickyHScroll(main) {
    const bar = el('div', 'dep-hbar');
    const spacer = el('div', 'dep-hbar-in');
    bar.appendChild(spacer); main.appendChild(bar);
    let lock = false, raf = 0;
    const gwrap = () => main.querySelector('.dep-impact .imp-gwrap');
    function sync() {
      const g = gwrap();
      if (!g || g.scrollWidth - g.clientWidth < 2) { bar.classList.remove('show'); return; }
      bar.classList.add('show');
      spacer.style.width = g.scrollWidth + 'px';
      if (lock) return;
      lock = true;
      const bMax = bar.scrollWidth - bar.clientWidth, gMax = g.scrollWidth - g.clientWidth;
      bar.scrollLeft = bMax > 0 ? (g.scrollLeft / gMax) * bMax : 0;
      lock = false;
    }
    bar.addEventListener('scroll', () => {
      if (lock) return; const g = gwrap(); if (!g) return;
      lock = true;
      const bMax = bar.scrollWidth - bar.clientWidth, gMax = g.scrollWidth - g.clientWidth;
      g.scrollLeft = bMax > 0 ? (bar.scrollLeft / bMax) * gMax : 0;  // gwrap 자체 핸들러가 커넥터 재계산
      lock = false;
    });
    // .imp-gwrap 의 휠/트랙패드 가로 스크롤(scroll 은 버블 안 하므로 캡처로 잡음) → 바 위치 반영
    main.addEventListener('scroll', () => {
      if (raf) return; raf = requestAnimationFrame(() => { raf = 0; sync(); });
    }, true);
    new ResizeObserver(() => sync()).observe(main);
    new MutationObserver(() => sync()).observe(main, { childList: true, subtree: true });
    sync();
  }

  function prCard(p, ctx) {
    const on = ctx && String(p.number) === String(ctx.sel);
    const merged = !!p.merged_at;   // 머지 시각이 없으면 아직 머지되지 않은 PR
    const card = el('div', 'dep-prc' + (on ? ' sel' : '') + (merged ? '' : ' warn'));
    const num = p.number != null ? '#' + p.number : '';
    const warnBadge = merged ? '' : '<span class="dep-prc-warn" title="Not merged — verify it is actually included in this deploy">⚠️ Unmerged</span>';
    card.innerHTML =
      (p.html_url ? `<a class="dep-prc-gh" href="${FM.escAttr(p.html_url)}" target="_blank" rel="noopener noreferrer" title="GitHub에서 PR 보기">↗</a>` : '') +
      `<div class="dep-prc-top"><span class="dep-prc-numwrap"><span class="dep-prc-num">PR ${FM.esc(num)}</span>${warnBadge}</span>` +
      `<span class="dep-prc-detail" data-act="detail">${on ? '▾ 영향도' : '영향도 보기 ↓'}</span></div>` +
      `<div class="dep-prc-title">${FM.esc(p.title || '')}</div>` +
      `<div class="dep-prc-by">${FM.esc(p.user || '')} · ${merged ? FM.esc(fmtTime(p.merged_at)) : '<span class="dep-prc-unmerged">Unmerged</span>'}</div>`;
    // PR 클릭 → 배포 영향도 안에서 pr= 선택 (커밋 영향도 뷰로 이동하지 않음). GitHub 링크는 통과.
    const go = (ev) => { if (ev.target.closest('.dep-prc-gh')) return; if (p.number != null) nav({ y: ctx.y, d: ctx.d, t: ctx.t, pr: String(p.number) }); };
    card.onclick = go;
    return card;
  }

  // 배포 서비스(touched)에서 "영향받는 쪽"(업스트림=호출측)으로만 hops 단계까지 확장한 서비스 집합.
  //   엣지 source→target = source 가 target 을 호출/의존. touched 가 바뀌면 그것을 호출하는 source 가
  //   영향받으므로, 영향은 target→source(역방향)로 전파된다. 그래서 callee→callers(역인접)만 따라간다.
  //   (양방향 확장은 무관한 다운스트림 의존까지 끌어와 서비스가 과다 출력되던 원인 → 영향 방향으로 한정)
  function expandSvcHops(touched, allEdges, hops) {
    const radj = new Map();   // callee(target) → 그를 호출하는 서비스들(sources)
    for (const e of allEdges) {
      if (!radj.has(e.tp)) radj.set(e.tp, new Set());
      radj.get(e.tp).add(e.sp);
    }
    const display = new Set(touched);
    let frontier = [...touched];
    for (let h = 0; h < hops && frontier.length; h++) {
      const next = [];
      for (const s of frontier) for (const nb of (radj.get(s) || [])) if (!display.has(nb)) { display.add(nb); next.push(nb); }
      frontier = next;
    }
    return display;
  }

  // 표시 단계(1/2/3차) 버튼 — 누르면 svcHop 을 바꿔 서비스 그래프를 다시 그린다.
  function buildSvcDepthCtl(wrap, touched) {
    const box = el('div', 'dep-depthctl', '<span class="dep-depthctl-label">표시 단계</span>');
    for (let d = 1; d <= 3; d++) {
      const btn = el('button', 'dep-depthbtn' + (d === svcHop ? ' on' : ''), d + '차');
      btn.title = `배포 서비스를 호출/의존하는 ${d}차 영향 서비스까지 표시`;
      btn.onclick = () => { if (svcHop !== d) { svcHop = d; renderServiceGraph(wrap, touched); } };
      box.appendChild(btn);
    }
    return box;
  }

  function renderServiceGraph(wrap, touched) {
    wrap.innerHTML = '';                 // 단계 전환 재호출 시 비우고 다시 그림
    const allEdges = serviceEdges();
    const display = expandSvcHops(touched, allEdges, svcHop);
    const nodeCount = new Map();
    for (const n of FM.NODES) if (n.project) nodeCount.set(n.project, (nodeCount.get(n.project) || 0) + 1);

    wrap.appendChild(buildSvcDepthCtl(wrap, touched));
    const grid = el('div', 'dep-svc-nodes');
    for (const svc of [...display].sort((a, b) => (touched.has(b) - touched.has(a)) || a.localeCompare(b))) grid.appendChild(serviceCard(svc, touched.has(svc), nodeCount.get(svc) || 0));
    wrap.appendChild(grid);
    if (display.size <= 1) wrap.appendChild(el('div', 'dep-svc-note', '이 배포 서비스를 호출(의존)하는 영향 서비스가 없습니다.'));
    const edges = allEdges.filter((e) => display.has(e.sp) && display.has(e.tp));
    FM.setCanvasEdges(edges);
    requestAnimationFrame(() => { FM.drawConnectors(); });
  }

  function serviceCard(svc, isTouched, nodes) {
    const hue = serviceHue(svc);
    const card = el('div', 'node-card dep-svc' + (isTouched ? ' touched' : ''));
    card.dataset.node = 'svc:' + svc;
    card.style.borderLeftColor = `hsl(${hue} 60% 50%)`;
    card.innerHTML =
      `<div class="dep-svc-name"><span class="dep-svc-dot" style="background:hsl(${hue} 60% 50%)"></span>${FM.esc(svc)}` +
      (isTouched ? '<span class="dep-svc-badge">배포</span>' : '') + '</div>' +
      `<div class="dep-svc-sub">${nodes} nodes</div>`;
    card.addEventListener('click', () => FM.setService(svc));
    FM.cardEls.set('svc:' + svc, card);
    return card;
  }
})();
