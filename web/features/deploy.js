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
  let bottomTab = 'ai';          // 하단 탭 선택 기억 — PR 전환(재렌더) 후에도 같은 탭을 유지(기본=AI 영향도 분석)
  let scrollMemo = null;         // 같은 컨텍스트(년/월/상태) 안 재렌더 시 복원할 {rail, main} 스크롤 위치
  const siExpanded = new Set();  // 서비스 영향도: 펼친 이웃 서비스 키('lo:'/'ro:' + svc) — 기본 접힘
  let depMain = null;            // 우측 메인 패널(.dep-main) — PR 타임라인↔목록 커넥터 앵커
  window.addEventListener('resize', () => { if (!depMain) return; requestAnimationFrame(() => {
    const dAxis = depMain.querySelector('.dep-tl-deploy .dep-tl-axis');   // 폭 변동 → 캡션 겹침 재계산
    if (dAxis) layoutDeployCaps(dAxis);
    drawPrConnector();
  }); });
  window.addEventListener('fm:zoom', () => { if (depMain) requestAnimationFrame(drawPrConnector); });  // 줌 변경 시 커넥터 좌표 재계산

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
  // GitHub PR URL(.../<org>/<repo>/pull/<n>)에서 org/repo 추출 — enterprise 호스트 포함.
  function parsePrUrl(url) {
    const m = String(url || '').match(/\/([^/]+)\/([^/]+)\/pull\/\d+/);
    return m ? { org: m[1], repo: m[2] } : {};
  }
  // release_version(배포 이미지)에서 커밋 SHA 추출 — 예: "...:master-b6d529b" → "b6d529b".
  //   'latest'(미지정)거나 끝 토큰이 hex SHA 가 아니면 null. pulls 의 mergeCommit 매칭에 사용.
  function commitFromVersion(v) {
    if (!v || v === 'latest') return null;
    const tail = String(v).split(/[-:/]/).pop() || '';   // master-b6d529b → b6d529b
    return /^[0-9a-f]{7,40}$/i.test(tail) ? tail.toLowerCase() : null;
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
    // 신포맷: deploy_list 가 PR 까지 포함 → index.json 에 prCount/ticketCount 가 함께 올 수 있다.
    //   구포맷: pr_index.json(entries) 이 별도로 카운트/파일을 제공(아래 루프에서 덮어씀).
    for (const q of (idx && idx.queries) || []) byDate.set(q.date, { date: q.date, deployCount: q.deployCount || 0, deployStatus: q.status, deployFile: q.file, prCount: q.prCount || 0, ticketCount: q.ticketCount || 0 });
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
  // per-root(bizunit)/projectName → 실제 git repo·namespace 해석. nexcore_job 등 catalog_project·
  //   catalog_component 가 모두 null 이라 repo 를 직접 못 얻을 때 사용 — 매니페스트의 동일 name 엔트리에서
  //   repo/namespace 를 가져온다(예: projectName "expired-account-open-clear-job" → repo "niffler", ns "kreature").
  //   그래야 {repo}.pulls.json 을 로드해 release_version 의 commit sha ↔ mergeCommit 매칭으로 PR url 을 찾는다.
  function repoFromProjectName(name) {
    if (!name) return null;
    const hit = ((FM.MANIFEST && FM.MANIFEST.projects) || []).find((p) => p && p.name === name);
    return hit ? { org: hit.namespace || '', repo: hit.repo || hit.name } : null;
  }
  function buildTickets(deploy, pr, projs) {
    const deployList = (deploy && deploy.deploy_list) || [];
    const depByTicket = new Map(deployList.map((d) => [d.release_ticket_id, d]));
    const tickets = []; const seen = new Set();
    for (const t of (pr && pr.by_ticket) || []) { seen.add(t.release_ticket_id); tickets.push(modelTicket(t, depByTicket.get(t.release_ticket_id), projs)); }
    for (const d of deployList) { if (!seen.has(d.release_ticket_id)) tickets.push(modelTicket(null, d, projs)); }
    return tickets;
  }
  // 배포 티켓 모델. 신스키마(release_tasks[] + 티켓 catalog_project.git_organization/git_repository,
  //   catalog_project 가 null 이면 task.release_strategy_option.projectName/component_name 으로 repo 도출)와
  //   구스키마(top-level git_repository/prs)를 모두 수용. PR 은 소속 repo(_org/_repo)를 달고 다닌다.
  function modelTicket(t, dep, projs) {
    const cat = (dep && dep.catalog_project) || {};   // catalog_project 는 null 일 수 있음
    const rawTasks = (dep && Array.isArray(dep.release_tasks)) ? dep.release_tasks : null;
    // 티켓 단위 git 좌표 — 신스키마는 catalog_project(.git_organization/.git_repository),
    //   구스키마/로컬은 top-level 또는 task.catalog_component.git_repo 에 있다.
    const tOrg = cat.git_organization || (t && t.git_organization) || (dep && dep.git_organization) || '';
    const tRepo = cat.git_repository || (t && t.git_repository) || (dep && dep.git_repository) || '';
    let tasks;
    if (rawTasks) {
      tasks = rawTasks.map((rt) => {
        const gr = (rt.catalog_component && rt.catalog_component.git_repo) || {};   // 로컬/구 포맷(task별 git_repo)
        const opt = rt.release_strategy_option || {};                               // nexcore_job 등은 여기 projectName 에 per-root
        // repo 우선순위: task.git_repo → 티켓 catalog_project(=tRepo) → projectName/component_name(=per-root) 매니페스트 해석
        let org = gr.org || tOrg || '';
        let repo = gr.repo || tRepo || '';
        if (!repo) {
          // catalog_project·catalog_component 가 모두 null(release_version 에 commit sha 만 있는 nexcore_job 등):
          //   projectName(=per-root/bizunit)을 매니페스트에서 실제 git repo·namespace 로 해석 →
          //   {repo}.pulls.json 의 mergeCommit ↔ commit sha 매칭으로 배포 PR·url({host}/{ns}/{repo}/pull/{n}) 을 찾는다.
          const pn = opt.projectName || rt.component_name || '';
          const resolved = repoFromProjectName(pn);
          if (resolved) { org = org || resolved.org; repo = resolved.repo; }
          else { repo = pn; org = org || opt.namespace || ''; }
        }
        // PR 객체 전체 필드(html_url 등)를 유지 — pulls/impact 임팩트가 없어도 PR 기능을 표시하기 위함.
        const prs = (rt.prs || []).map((p) => ({ ...p, _org: org, _repo: repo }));
        // 그래도 repo 가 없으면 PR html_url(.../<org>/<repo>/pull/<n>)에서 org/repo 를 보충.
        if (!repo) {
          for (const p of prs) { const u = parsePrUrl(p.html_url); if (u.repo) { org = org || u.org; repo = u.repo; break; } }
          prs.forEach((p) => { p._org = org; p._repo = repo; });
        }
        return {
          component: rt.component_name || repo, order: rt.release_order || 0,
          strategy: rt.release_strategy || '', step: normStatus(rt.task_step), org, repo, prs,
          deployedCommit: commitFromVersion(rt.release_version),   // 배포 이미지 커밋 SHA(latest 면 null)
        };
      }).sort((a, b) => a.order - b.order);
    } else {
      const org = tOrg, repo = tRepo;
      const prs = ((t && t.prs) || (dep && dep.prs) || []).map((p) => ({ ...p, _org: org, _repo: repo }));
      tasks = [{ component: cat.project_name || repo, order: 1, strategy: '', step: normStatus((dep && dep.ticket_step) || (t && t.ticket_step)), org, repo, prs }];
    }
    const primary = tasks[0] || { org: '', repo: '' };
    // PR 목록: 여러 release_task 가 같은 PR(같은 org/repo + number)을 가질 수 있으므로 중복 제거(첫 등장 유지).
    const seenPr = new Set();
    const prs = tasks.flatMap((x) => x.prs).filter((p) => {
      const k = (p._org || '') + '/' + (p._repo || '') + '#' + p.number;
      if (seenPr.has(k)) return false;
      seenPr.add(k); return true;
    });
    // 타임라인: 신청(created)·승인(approved)·배포(deployed)·진행(progress, 없을 수 있음)·수정(modified)
    const timeline = {
      created:  { key: 'created',  label: '신청', at: (dep && dep.created_at) || null,  by: (dep && dep.created_by) || (t && t.created_by) || '' },
      approved: { key: 'approved', label: '승인', at: (dep && dep.approved_at) || null, by: (dep && dep.approved_by) || '' },
      deployed: { key: 'deployed', label: '배포', at: (dep && (dep.deployed_at || dep.release_at)) || (t && t.release_at) || null, by: '' },
      progress: { key: 'progress', label: '진행', at: (dep && dep.progress_at) || null, by: (dep && dep.progress_by) || '' },
      modified: { key: 'modified', label: '수정', at: (dep && dep.modified_at) || null, by: '' },
    };
    return {
      id: (t && t.release_ticket_id) || (dep && dep.release_ticket_id),
      summary: (t && t.summary) || (dep && dep.summary) || '(제목 없음)',
      phase: (dep && dep.phase) || (t && t.phase) || '',
      platform: (dep && dep.platform) || (t && t.platform) || '',
      releaseAt: timeline.deployed.at || '',
      createdBy: timeline.created.by, approvedBy: timeline.approved.by,
      verifier: (dep && dep.verifier) || '', monitorBy: (dep && dep.monitor_by) || '',
      businessMonitorBy: (dep && dep.business_monitor_by) || '',
      org: primary.org, repo: primary.repo, projectName: cat.project_name || '',
      status: normStatus((dep && dep.ticket_step) || (t && t.ticket_step)),
      prs, tasks, timeline,
      service: mapRepoToService(primary.repo, cat.project_name || '', projs),
    };
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
  // 같은 레일 목록을 보여주는 컨텍스트 키 — 년/월/상태가 같으면 배포 선택만 바뀐 것(레일 내용 동일).
  function ctxKey() { return curYear() + '|' + curMonth() + '|' + (curStatus() || ''); }

  function nav(params) {
    if (!('st' in params)) { const st = curStatus(); if (st) params = Object.assign({ st }, params); }
    // 배포 클릭(=같은 컨텍스트 내 선택 변경)이면 재렌더로 레일/메인이 새로 그려지며 스크롤이 0으로
    //   리셋돼 화면이 상단으로 튄다. 컨텍스트가 그대로면 직전 스크롤 위치를 기억해 복원한다.
    const prevKey = ctxKey();
    const rail = document.querySelector('.dep-rail'), main = document.querySelector('.dep-main');
    FM.pushViewUrl('deploy', params);
    scrollMemo = (rail && ctxKey() === prevKey)
      ? { rail: rail.scrollTop, main: main ? main.scrollTop : 0 } : null;
    render();
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
      // URL 에 PR 이 명시되면(사용자 클릭) ticket.prs(배포 명시 PR)에 없어도 존중한다 —
      //   PR 목록은 pulls 인덱스 기반(타임라인 구간 PR 포함)이라 배포 명시 PR 보다 넓다.
      //   명시값이 없을 때만 첫 PR 로 기본 선택.
      if (prNumber != null && prNumber !== '') {
        const pr = prs.find((p) => String(p.number) === String(prNumber));
        prNumber = pr ? String(pr.number) : String(prNumber);
      } else prNumber = prs.length ? String(prs[0].number) : null;
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
      scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; FM.drawConnectors(); drawPrConnector(); });
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
      // 같은 컨텍스트 재렌더면 직전 스크롤 위치 복원(콘텐츠 높이가 짧으면 브라우저가 자동 clamp).
      if (scrollMemo) {
        const memo = scrollMemo; scrollMemo = null;
        requestAnimationFrame(() => { rail.scrollTop = memo.rail; main.scrollTop = memo.main; });
      }
    });
  }

  function renderMissing(cols) {
    const box = el('div', 'browse-empty dep-empty',
      '<div class="be-ico">🚀</div>' +
      '<div class="be-msg">배포 영향도 데이터가 없습니다<br>' +
      '<span class="hint"><code>web/data/deploy/</code> 에 <code>index.json</code> ·' +
      ' <code>&lt;년도&gt;/&lt;날짜&gt;/deploy_list.json</code>(PR·git 정보 포함) 을 넣은 뒤 새로고침하세요.</span></div>' +
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
        const svc = t.service ? FM.svcBadge(t.service) : (t.repo ? `<span class="dep-svc-tag no">미매핑</span>` : '');
        const tWarn = (t.prs || []).some(isUnmergedPr) ? '<span class="dep-di-warn" title="Has un-merged PR(s)">⚠️</span>' : '';
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
    depMain = main;
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
    const metaHtml = `${tk.platform ? `<span class="dep-chip">${FM.esc(tk.platform)}</span>` : ''}` +
      `${tk.phase ? `<span class="dep-chip">${FM.esc(tk.phase)}</span>` : ''}` +
      `${repo ? `<span class="dep-repo">${FM.esc(repo)}</span>` : ''}` +
      `${tk.service ? FM.svcBadge(tk.service) : (tk.repo ? `<span class="dep-svc-tag no">그래프 미매핑</span>` : '')}`;
    // 좌우 공간을 활용한 2줄 헤더: (1) #번호·제목 ───── 날짜·시간, (2) 메타칩 ───── 담당자
    head.innerHTML =
      `<div class="dep-mh-r1">` +
        `<span class="dep-mh-id">#${FM.esc(String(tk.id))}</span>` +
        `<span class="dep-mh-summary" title="${FM.escAttr(tk.summary)}">${FM.esc(tk.summary)}</span>` +
        `<span class="dep-mh-time">${FM.esc(d)} · ${FM.esc(fmtTime(tk.releaseAt))}</span>` +
      `</div>` +
      `<div class="dep-mh-r2">` +
        `<span class="dep-mh-meta">${metaHtml}</span>` +
        (peopleHtml ? `<span class="dep-mh-people">${peopleHtml}</span>` : '') +
      `</div>`;
    main.appendChild(head);

    // 타임라인 — 배포 진행(신청/승인/배포/진행/수정) + PR(신청 전 최대 5개 + 신청~배포 구간 전체)
    const tlSec = el('div', 'dep-section dep-timeline-sec');
    // 제목 우측 끝에 범례 슬롯(renderTimelines 가 채움)
    const tlHead = el('div', 'dep-sec-head dep-tl-head');
    tlHead.innerHTML = '<span>타임라인</span><span class="dep-tl-legend"></span>';
    tlSec.appendChild(tlHead);
    const tlHost = el('div', 'dep-timeline-host');
    tlHost.innerHTML = '<div class="dep-loading">타임라인 불러오는 중…</div>';
    tlSec.appendChild(tlHost);
    main.appendChild(tlSec);
    renderTimelines(tlHost, tk, { y, d, t: eff.ticketId, sel: eff.prNumber }, seq);

    // PR 목록 — deploy_list 의 prs 가 number 만 있어도, pulls 인덱스에서 title/author/mergedAt/url 보강.
    const prSec = el('div', 'dep-section');
    const prHead = el('div', 'dep-sec-head', `PR 목록 (${tk.prs.length})`);
    const prHost = el('div', 'dep-pr-grid');
    prSec.append(prHead, prHost);
    main.appendChild(prSec);
    renderPrList(prHead, prHost, tk, { y, d, t: eff.ticketId, sel: eff.prNumber }, seq);

    // 하단 탭 — 서비스 영향도·연관관계 / PR 커밋 영향도 / 변경 파일 (한 번에 하나만 표시).
    buildBottomTabs(main, tk, eff, seq, repo);
  }

  // 하단 3개 콘텐츠(서비스 영향도·연관관계 / PR 커밋 영향도 / 변경 파일)를 탭으로 묶는다.
  //   각 패널은 처음 활성화될 때 지연 렌더(빌드)하고, 전환 시 커넥터를 재계산한다.
  function buildBottomTabs(main, tk, eff, seq, repo) {
    const sec = el('div', 'dep-section dep-tabs-sec');
    const bar = el('div', 'dep-tabbar');
    const body = el('div', 'dep-tab-body');
    const hasPr = eff && eff.prNumber != null;
    // AI 영향도 분석은 PR 단위 산출물(<base>.AI분석결과/<PR번호>.md) → PR 선택 필요.
    const tabs = [
      { key: 'ai', label: '🤖 AI 영향도 분석', disabled: !hasPr, build: (host) => renderAiAnalysis(host, eff, seq) },
      { key: 'impact', label: '서비스 영향도', disabled: !hasPr, build: (host) => renderServiceImpact(host, eff, seq) },
      { key: 'files', label: '변경 파일', disabled: !hasPr, build: (host) => renderPrFiles(host, eff, seq) },
    ];
    const btns = {}, panels = {};
    let active = null;
    // remember=true(사용자 클릭)면 선택 탭을 bottomTab 에 저장 → PR 전환(재렌더) 후에도 같은 탭 유지.
    function activate(key, remember) {
      if (active === key) return;
      active = key;
      if (remember) bottomTab = key;
      for (const t of tabs) {
        const on = t.key === key;
        btns[t.key].classList.toggle('on', on);
        panels[t.key].classList.toggle('show', on);
        if (on && !panels[t.key].dataset.built) { panels[t.key].dataset.built = '1'; t.build(panels[t.key]); }
      }
      requestAnimationFrame(() => { FM.drawConnectors(); drawPrConnector(); });
    }
    for (const t of tabs) {
      const btn = el('button', 'dep-tab' + (t.disabled ? ' disabled' : ''), t.label);
      if (t.disabled) btn.disabled = true; else btn.onclick = () => activate(t.key, true);
      btns[t.key] = btn; bar.appendChild(btn);
      const panel = el('div', 'dep-tabpanel' + (t.key === 'ai' ? ' dep-ai' : t.key === 'impact' ? ' dep-impact' : t.key === 'files' ? ' dep-files' : ''));
      panels[t.key] = panel; body.appendChild(panel);
    }
    sec.append(bar, body); main.appendChild(sec);
    // 직전에 보던 탭 복원 — 단, 이 배포에서 비활성인 탭이면 첫 활성 탭으로 폴백(선호는 유지).
    const want = tabs.find((t) => t.key === bottomTab && !t.disabled)
      ? bottomTab : (tabs.find((t) => !t.disabled) || tabs[0]).key;
    activate(want, false);
  }

  // 선택 PR 의 변경 파일 목록 + 변경 전/후 코드(unified diff)를 하단에 노출.
  //   데이터: <project>.pulls 인덱스 → <project>.pulls/<번호>.json 샤드(files[].patch).
  function pullsRelFor(tk) {
    return pullsRelByRepo(tk && tk.org, tk && tk.repo, tk);
  }
  // PR pulls 인덱스 경로. 분석 매니페스트에 있으면 그 경로, 없으면 git namespace/repo 규약
  //   `projects/<namespace>/<repo>/<repo>/<repo>.pulls.json` (배포가 가리키는 repo 가 그래프 분석 대상이 아닐 수 있음).
  //   매칭: per-root name 정확일치 우선 → git_repository ↔ manifest.repo. 규약 namespace 는 manifest.namespace 우선
  //   (배포의 git_organization 은 데이터 경로 namespace 와 다를 수 있어 — 예: 실제 org=moneyball, namespace=nexcore).
  function manifestRelByRepo(field, org, repo, tk) {
    const projects = (FM.MANIFEST && FM.MANIFEST.projects) || [];
    const nameCands = [tk && tk.service, repo, tk && tk.projectName].filter(Boolean);
    let byRepo = null;
    for (const p of projects) {
      if (!p || !p[field]) continue;
      if (nameCands.includes(p.name)) return p[field];
      if (repo && p.repo === repo && !byRepo) byRepo = p;
    }
    if (byRepo) return byRepo[field];
    const ns = (projects.find((p) => p && p.repo === repo && p.namespace) || {}).namespace || org;
    return (ns && repo) ? `projects/${ns}/${repo}/${repo}/${repo}.${field}.json` : null;
  }
  function pullsRelByRepo(org, repo, tk) { return manifestRelByRepo('pulls', org, repo, tk); }
  // impact 인덱스 경로 — 동일 매칭 규약.
  function impactRelByRepo(org, repo, tk) { return manifestRelByRepo('impact', org, repo, tk); }
  // 선택된 PR 의 소속 repo(멀티 task — PR 마다 repo 다를 수 있음). 못 찾으면 티켓 대표 repo.
  function prRepoOf(tk, number) {
    const p = ((tk && tk.prs) || []).find((x) => String(x.number) === String(number));
    return { org: (p && p._org) || (tk && tk.org), repo: (p && p._repo) || (tk && tk.repo) };
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
  function renderPrFiles(panel, eff, seq) {
    if (!eff || eff.prNumber == null) { panel.innerHTML = '<div class="dep-hint">선택된 PR이 없습니다.</div>'; return; }
    const { org, repo } = prRepoOf(eff.ticket, eff.prNumber);
    const pullsRel = pullsRelByRepo(org, repo, eff.ticket);
    panel.innerHTML = '';
    const host = el('div', 'dep-files-host');
    host.innerHTML = '<div class="dep-loading">변경 파일 불러오는 중…</div>';
    panel.appendChild(host);
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

  /* ───────── AI 영향도 분석 — PR 단위 <base>.AI분석결과/<PR번호>.md(마크다운) 임베드 ───────── */
  // AI 산출물 경로: impact 경로(impactRelByRepo)의 .impact.json 을 .AI분석결과/<PR번호>.md 로 치환.
  function aiRelForPr(org, repo, tk, prNumber) {
    const imp = impactRelByRepo(org, repo, tk);
    return imp ? imp.replace(/\.impact\.json$/, `.AI분석결과/${prNumber}.md`) : null;
  }
  // 최소 마크다운 렌더러(안전: 모든 텍스트 FM.esc 후 인라인 변환). 지원: 제목/목록/인용/구분선/
  //   표/코드펜스/문단 + 인라인(코드·굵게·기울임·링크). AI 리포트의 고정 스켈레톤에 맞춘 범위.
  function inlineMd(s) {
    let h = FM.esc(s);
    h = h.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
    h = h.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) =>
      /^https?:\/\//.test(u) ? `<a href="${FM.escAttr(u)}" target="_blank" rel="noopener">${t}</a>` : t);
    h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    return h;
  }
  function mdToHtml(md, selPr) {
    const lines = String(md).replace(/\r\n?/g, '\n').replace(/^<!--[\s\S]*?-->\s*/m, '').split('\n');
    const out = [];
    let i = 0, inList = false, inCode = false;
    const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
    while (i < lines.length) {
      const ln = lines[i];
      if (/^```/.test(ln)) {                       // 코드 펜스
        if (!inCode) { closeList(); out.push('<pre class="dep-md-pre"><code>'); inCode = true; }
        else { out.push('</code></pre>'); inCode = false; }
        i++; continue;
      }
      if (inCode) { out.push(FM.esc(ln)); i++; continue; }
      if (/^\s*$/.test(ln)) { closeList(); i++; continue; }
      if (/^#{1,6}\s/.test(ln)) {                  // 제목
        closeList();
        const lvl = ln.match(/^#+/)[0].length;
        const txt = ln.replace(/^#+\s/, '');
        const m = txt.match(/PR\s*#(\d+)/i);        // PR 섹션 → 앵커 id + 선택 PR 하이라이트
        const idAttr = m ? ` id="dep-ai-pr-${m[1]}"` : '';
        const hot = m && selPr != null && String(m[1]) === String(selPr) ? ' dep-ai-sel' : '';
        out.push(`<h${lvl}${idAttr} class="dep-md-h${lvl}${hot}">${inlineMd(txt)}</h${lvl}>`);
        i++; continue;
      }
      if (/^\s*>\s?/.test(ln)) { closeList(); out.push(`<blockquote class="dep-md-bq">${inlineMd(ln.replace(/^\s*>\s?/, ''))}</blockquote>`); i++; continue; }
      if (/^\s*([-*]{3,}|_{3,})\s*$/.test(ln)) { closeList(); out.push('<hr class="dep-md-hr">'); i++; continue; }
      if (/^\s*\|.*\|\s*$/.test(ln) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {   // 표
        closeList();
        const row = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        const head = row(ln); i += 2; const body = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { body.push(row(lines[i])); i++; }
        out.push('<table class="dep-md-table"><thead><tr>' + head.map((c) => `<th>${inlineMd(c)}</th>`).join('') + '</tr></thead><tbody>' +
          body.map((r) => '<tr>' + r.map((c) => `<td>${inlineMd(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
        continue;
      }
      if (/^\s*[-*]\s+/.test(ln)) {                 // 목록
        if (!inList) { out.push('<ul class="dep-md-ul">'); inList = true; }
        out.push(`<li>${inlineMd(ln.replace(/^\s*[-*]\s+/, ''))}</li>`);
        i++; continue;
      }
      closeList(); out.push(`<p class="dep-md-p">${inlineMd(ln)}</p>`); i++;
    }
    if (inCode) out.push('</code></pre>');
    closeList();
    return out.join('\n');
  }
  function renderAiAnalysis(panel, eff, seq) {
    panel.innerHTML = '';
    const host = el('div', 'dep-ai-host');
    panel.appendChild(host);
    if (!eff || eff.prNumber == null) { host.innerHTML = '<div class="dep-hint">선택된 PR이 없습니다.</div>'; return; }
    host.innerHTML = '<div class="dep-loading">AI 영향도 분석 불러오는 중…</div>';
    const { org, repo } = prRepoOf(eff.ticket, eff.prNumber);
    const rel = aiRelForPr(org, repo, eff.ticket, eff.prNumber);
    if (!rel) { host.innerHTML = '<div class="dep-hint">이 PR 의 AI 분석 결과 경로를 찾을 수 없습니다.</div>'; return; }
    // 한글 파일명 포함 — encodeURI 로 안전하게. 문서 base(web/) 기준 상대경로.
    fetch(encodeURI('data/' + rel))
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.text(); })
      .then((md) => {
        if (renderSeq !== seq) return;
        host.innerHTML = '';
        const note = el('div', 'dep-ai-note',
          `🤖 PR #${FM.esc(String(eff.prNumber))} · 로컬 Claude CLI 가 PR diff·호출그래프·repo 소스를 분석한 결과 <span class="dep-ai-hint">(${FM.esc(rel.replace(/^.*\//, ''))})</span>`);
        const md_ = el('div', 'dep-md dep-ai-md', mdToHtml(md));
        host.append(note, md_);
      })
      .catch((e) => {
        if (renderSeq !== seq) return;
        host.innerHTML = String(e.message) === '404'
          ? '<div class="dep-hint">이 PR 의 AI 분석 결과가 아직 생성되지 않았습니다.<br><span class="dep-ai-hint">생성: <code>node flowmap-ai/run-batch.js</code></span></div>'
          : '<div class="dep-hint">AI 분석 결과 로드 실패.</div>';
      });
  }

  // 선택된 PR 의 커밋 영향도(분석 바 + 경계 투영 그래프)를 하단에 임베드한다.
  // impact.js 의 공개 API(FM.impact.renderInto)를 재사용 — 커밋 영향도 뷰와 동일한 컴포넌트.
  // ───────── 서비스 영향도 — 선택 PR 의 변경 노드를 호출/피호출 "서비스 단위"로 묶어 표시 ─────────
  //   가운데=변경 서비스, 왼쪽=피호출 서비스(변경이 호출), 오른쪽=호출 서비스(변경을 호출).
  //   이웃 서비스 카드 클릭 → 그 방향으로 연결된 endpoint 노드를 펼친다(1단계).
  function renderServiceImpact(panel, eff, seq) {
    if (!eff || eff.prNumber == null) { panel.innerHTML = '<div class="dep-hint">선택된 PR이 없습니다.</div>'; return; }
    panel.innerHTML = '';
    const host = el('div', 'dep-si-host');
    host.innerHTML = '<div class="dep-loading">서비스 영향도 계산 중…</div>';
    panel.appendChild(host);
    const { org, repo } = prRepoOf(eff.ticket, eff.prNumber);   // 선택 PR 소속 repo — impact _project 와 매칭
    FM.loadFeature('impact')
      .then(() => FM.impact && FM.impact.ensure())
      .then(() => FM.impact && FM.impact.ensureSource(impactRelByRepo(org, repo, eff.ticket)))
      .then(async () => {
        if (renderSeq !== seq) return;
        const detail = (FM.impact && FM.impact.changedDetail)
          ? (await FM.impact.changedDetail(eff.prNumber, repo))
          : { changedIds: [], endpoints: [], children: {} };
        if (renderSeq !== seq) return;
        let first = true;
        const redraw = () => { buildServiceImpact(host, detail, redraw, seq, first); first = false; };
        redraw();
      }).catch(() => { host.innerHTML = '<div class="dep-hint">서비스 영향도 로드 실패.</div>'; });
  }

  function buildServiceImpact(host, detail, redraw, seq, resetSel) {
    if (renderSeq !== seq) return;
    const changedIds = detail.changedIds || [];
    const endpoints = detail.endpoints || [];
    const epChildren = detail.children || {};
    const svcOf = (id) => { const n = FM.nodeById.get(id); return n && n.project; };
    const addSet = (m, k, v) => (m.get(k) || m.set(k, new Set()).get(k)).add(v);
    // ── "수정노드를 가진 endpoint(앵커)" 중심 + 실제 endpoint↔endpoint 연결 ──
    const changedSet = new Set(changedIds);
    // 앵커 = 수정 노드를 가진(자식 보유) 또는 그 자체가 변경된 영향 엔드포인트. 수정과 무관한 영향 엔드포인트는 제외.
    const isAnchor = (id) => (epChildren[id] && epChildren[id].length) || changedSet.has(id);
    const anchorBySvc = new Map();   // svc → Set(anchor endpoint id)
    const anchorSet = new Set();
    for (const id of endpoints) {
      if (!isAnchor(id)) continue;
      const s = svcOf(id); if (!s) continue;
      addSet(anchorBySvc, s, id); anchorSet.add(id);
    }
    // 폴백: 앵커를 못 가리면(엔드포인트로 롤업 안 되는 내부 변경) 변경 노드 자체를 중심에 둔다.
    let fallback = false;
    if (!anchorSet.size) {
      fallback = true;
      for (const id of changedIds) { const s = svcOf(id); if (s) { addSet(anchorBySvc, s, id); anchorSet.add(id); } }
    }
    if (!anchorBySvc.size) {
      host.innerHTML = '<div class="dep-hint">이 PR 의 변경이 호출 그래프에 닿지 않습니다.</div>';
      FM.cardEls.clear(); FM.setCanvasEdges([]); requestAnimationFrame(() => FM.drawConnectors()); return;
    }
    // 앵커 endpoint 에서 내부(같은 서비스) 체인을 통과해 닿는 "다른 서비스"의 개별 경계 endpoint
    const cross = (startId, edgeMap, nbOf, srcSvc) => {
      const res = [], seen = new Set([startId]), stack = [startId];
      while (stack.length) {
        const cur = stack.pop();
        for (const e of (edgeMap.get(cur) || [])) {
          const nb = nbOf(e); if (!FM.nodeById.has(nb) || seen.has(nb)) continue; seen.add(nb);
          const s = svcOf(nb);
          if (s && s !== srcSvc) res.push({ svc: s, id: nb }); else stack.push(nb);
        }
      }
      return res;
    };
    // 실제 노드 id 쌍 엣지 + 사이드(이웃) 개별 endpoint 카드 — 앵커에 직접 연결된 노드만 남긴다.
    const edgeList = [];                                       // {s, t}  실제 endpoint id 쌍
    const calleeBySvc = new Map(), callerBySvc = new Map();    // svc → Set(이웃 endpoint id)
    const nbLoc = new Map();                                   // 이웃 endpoint id → { prefix:'lo'|'ro', svc } (접힘 시 그룹 카드로 엣지 리다이렉트)
    const pushNb = (map, prefix, id, svc) => { if (anchorSet.has(id) || nbLoc.has(id)) return; nbLoc.set(id, { prefix, svc }); addSet(map, svc, id); };
    anchorSet.forEach((aid) => {
      const sv = svcOf(aid); if (!sv) return;
      for (const { svc, id } of cross(aid, FM.outEdges, (e) => e.target, sv)) { edgeList.push({ s: aid, t: id }); pushNb(calleeBySvc, 'lo', id, svc); }
      for (const { svc, id } of cross(aid, FM.inEdges, (e) => e.source, sv)) { edgeList.push({ s: id, t: aid }); pushNb(callerBySvc, 'ro', id, svc); }
    });

    // ── DOM ──
    host.innerHTML = '';
    FM.cardEls.clear();
    if (resetSel) { FM.state.sel = null; FM.setProcessDockEnabled(false); siExpanded.clear(); }   // 새 PR 진입 시 이전 선택·독·펼침 해제
    // 변경 노드 클릭 → 상세 + 프로세스 흐름 독 (커밋 영향도와 동일). state.sel 직접 제어로 URL 오염 방지.
    FM.setDockChangedNodes(new Set(changedIds));
    const setSelection = (id) => {
      FM.state.sel = (id && FM.nodeById.has(id)) ? id : null;
      FM.renderDetail();
      FM.setProcessDockEnabled(true);   // 선택 노드 기준 프로세스 흐름 독 표시
      FM.applyHighlight();
    };
    const nodeCard = (id) => {
      const card = FM.makeCard(id, { noCenter: true, onPick: setSelection });   // 개별 노드 — cardEls[id] 등록
      // 노드 자체가 실제 변경된 메서드면 카드에 "수정" 뱃지(+주황 링) — 영향만 받은 노드와 구분.
      if (changedSet.has(id)) { card.classList.add('imp-changed'); card.insertAdjacentHTML('beforeend', '<span class="dep-si-modtag">수정</span>'); }
      return card;
    };
    // 영향 엔드포인트 카드 아래로 "수정된 서비스/컴포넌트" 자식 행을 매단다 (커밋 영향도와 동일한 표현).
    const KID_MAX = 8;
    const appendKids = (card, epId) => {
      const kids = epChildren[epId] || [];
      if (!kids.length) return;
      const wrap = el('div', 'imp-kids');
      kids.slice(0, KID_MAX).forEach((kid) => {
        const kn = FM.nodeById.get(kid); if (!kn) return;
        const row = el('div', 'imp-kid',
          `<span class="imp-kid-layer">${FM.esc(kn.layer || 'CODE')}</span>` +
          `<span class="imp-kid-name">${FM.esc(kn.method || kid)}</span>` +
          `<span class="imp-kid-tag">수정</span>`);
        row.title = [kn.fqcn, kn.file ? kn.file + (kn.line ? ':' + kn.line : '') : null, kn.description].filter(Boolean).join('\n');
        row.addEventListener('click', (e) => { e.stopPropagation(); setSelection(kid); });
        wrap.appendChild(row);
      });
      if (kids.length > KID_MAX) wrap.appendChild(el('div', 'imp-kid more', `+${kids.length - KID_MAX} 수정`));
      card.appendChild(wrap);
    };
    const graph = el('div', 'dep-si');
    const colL = el('div', 'dep-si-col left',  '<div class="dep-si-coltitle">◀ 피호출 서비스</div>');
    const colC = el('div', 'dep-si-col center', '<div class="dep-si-coltitle">수정된 서비스</div>');
    const colR = el('div', 'dep-si-col right', '<div class="dep-si-coltitle">호출 서비스 ▶</div>');

    // 서비스 = 테두리로 묶인 그룹 영역(별도 노드 아님). 헤더(이름·개수·캐럿) 토글로 body 접기/펼치기.
    //   collapsible=false → 항상 펼침(가운데 '수정된 서비스'). 헤더 element 를 그 서비스의 커넥터 앵커로 등록.
    //   반환 {box, body}: 호출부가 body 에 endpoint 카드를 채운다(접힘이면 비워 두면 됨).
    const svcGroupBox = (key, svc, countLabel, opts) => {
      const o = opts || {};
      const expanded = o.expanded !== false;
      const box = el('div', 'dep-si-grp' + (o.changed ? ' changed' : '') + (expanded ? ' open' : ' closed'));
      box.style.setProperty('--svc-h', serviceHue(svc));
      const head = el('div', 'dep-si-ghead' + (o.collapsible && o.onToggle ? ' clickable' : ''));
      head.dataset.node = key;   // 접힘 시 endpoint↔서비스 커넥터가 이 헤더로 붙는다
      head.innerHTML =
        (o.collapsible ? '<span class="dep-si-caret">▶</span>' : '') +
        '<span class="dep-si-dot"></span>' +
        `<span class="dep-si-gname">${FM.esc(svc)}</span>` +
        `<span class="dep-si-gcount">${FM.esc(countLabel)}</span>`;
      if (o.collapsible && o.onToggle) head.addEventListener('click', o.onToggle);
      box.appendChild(head);
      FM.cardEls.set(key, head);
      const body = el('div', 'dep-si-gbody');
      box.appendChild(body);
      return { box, body };
    };

    // 가운데: "수정노드를 가진 endpoint(앵커)" 박스 — 서비스별 헤더(라벨) + 앵커 endpoint 카드(+수정 자식). 클릭 시 프로세스 흐름.
    const labelOf = (id) => { const n = FM.nodeById.get(id); return (n && (n.endpoint || n.method)) || id; };
    for (const svc of [...anchorBySvc.keys()].sort()) {
      const eps = [...anchorBySvc.get(svc)].sort((a, b) => String(labelOf(a)).localeCompare(String(labelOf(b))));
      const { box, body } = svcGroupBox('si:c:' + svc, svc, `${fallback ? '변경' : '수정 endpoint'} ${eps.length}`, { changed: true });
      eps.forEach((id) => { const card = nodeCard(id); if (!fallback) appendKids(card, id); body.appendChild(card); });
      colC.appendChild(box);
    }
    // 왼쪽=피호출(앵커가 호출) / 오른쪽=호출(앵커를 호출) — 기본은 서비스 그룹 카드로 접고, 누르면 개별 endpoint 로 펼친다.
    const renderNeighbors = (col, map, prefix) => {
      if (!map.size) { col.appendChild(el('div', 'dep-si-empty', '없음')); return; }
      for (const svc of [...map.keys()].sort()) {
        const key = prefix + ':' + svc, ids = [...map.get(svc)].sort((a, b) => String(labelOf(a)).localeCompare(String(labelOf(b))));
        const expanded = siExpanded.has(key);
        const { box, body } = svcGroupBox('si:' + key, svc, `endpoint ${ids.length}`, {
          collapsible: true, expanded,
          onToggle: () => { if (expanded) siExpanded.delete(key); else siExpanded.add(key); redraw(); },
        });
        if (expanded) ids.forEach((id) => body.appendChild(nodeCard(id)));
        col.appendChild(box);
      }
    };
    renderNeighbors(colL, calleeBySvc, 'lo');
    renderNeighbors(colR, callerBySvc, 'ro');
    graph.append(colL, colC, colR);
    host.appendChild(graph);

    // ── 엣지: 펼친 이웃은 실제 endpoint ↔ endpoint, 접힌 이웃은 endpoint ↔ 서비스 그룹 카드 ──
    const edges = [], eseen = new Set();
    const addEdge = (s, t, kc) => { const k = s + '>' + t; if (s === t || eseen.has(k)) return; eseen.add(k); edges.push({ source: s, target: t, kc: kc || 's2s' }); };
    const sideAnchor = (id) => { const li = nbLoc.get(id); return (li && !siExpanded.has(li.prefix + ':' + li.svc)) ? 'si:' + li.prefix + ':' + li.svc : id; };
    edgeList.forEach(({ s, t }) => { const S = sideAnchor(s), T = sideAnchor(t); if (FM.cardEls.has(S) && FM.cardEls.has(T)) addEdge(S, T); });
    FM.setCanvasEdges(edges);
    requestAnimationFrame(() => FM.drawConnectors());
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

  // PR 표시 메타데이터 보강용 — pulls 인덱스(<per-root>.pulls.json) 의 pulls[] 에는
  //   number 별 title/author/mergedAt/url 이 모두 있으므로, deploy_list 의 prs 가 number 만
  //   있어도 여기서 채운다. 인덱스는 ticket(repo)당 1회 로드 후 캐시.
  const pullsMetaCache = new Map();
  const RK = (org, repo) => (org || '') + ' ' + (repo || '');   // repo 키
  function pullsMetaByRepo(org, repo, tk) {
    const rel = pullsRelByRepo(org, repo, tk);
    if (!rel) return Promise.resolve(null);
    if (pullsMetaCache.has(rel)) return pullsMetaCache.get(rel);
    const p = FM.fetchData('data/' + rel).then((idx) => {
      const byNum = new Map();
      for (const e of (idx && idx.pulls) || []) byNum.set(String(e.number), e);
      return { byNum, list: (idx && idx.pulls) || [] };
    }).catch(() => null);
    pullsMetaCache.set(rel, p);
    return p;
  }
  // 티켓의 모든 task repo pulls 인덱스를 로드 → repo키 → {byNum,list}
  async function loadPullsForTicket(tk) {
    const keys = [...new Set((tk.tasks || []).map((x) => RK(x.org, x.repo)))];
    const out = new Map();
    await Promise.all(keys.map(async (k) => {
      const [org, repo] = k.split(' ');
      out.set(k, await pullsMetaByRepo(org, repo, tk));
    }));
    return out;
  }
  // 보강 전(number 만) PR 은 "미머지"로 단정하지 않는다 — 메타가 하나라도 있는데 mergedAt 만 없을 때만.
  function isUnmergedPr(p) { return !p.merged_at && !!(p.title || p.user || p.html_url); }
  async function renderPrList(headEl, host, tk, ctx, seq) {
    // PR 목록도 타임라인과 동일하게 pulls.json 기반 선택셋을 쓴다(타임라인 점 ↔ 목록 카드 1:1 정합).
    const sel = await selectTimelinePulls(tk, seq);
    if (!sel || renderSeq !== seq) return;
    const prs = sel.perRepo.flatMap((r) => r.shown);
    const unmergedCount = prs.filter(isUnmergedPr).length;
    headEl.innerHTML = `PR 목록 (${prs.length})` +
      (unmergedCount ? ` <span class="dep-sec-warn" title="${unmergedCount} un-merged PR(s)">⚠️ Unmerged ${unmergedCount}</span>` : '');
    host.innerHTML = '';
    if (!prs.length) { host.appendChild(el('div', 'dep-hint', '연결된 PR이 없습니다.')); return; }
    for (const p of prs) host.appendChild(prCard(p, ctx));
    // PR 목록이 비동기로 채워지며 dep-main 높이가 늘어 서비스 영향도 카드가 아래로 밀린다.
    // 최초 1회만 그려둔 서비스 커넥터가 옛 위치로 어긋나므로, 확정된 레이아웃으로 다시 그린다.
    requestAnimationFrame(() => { FM.drawConnectors(); drawPrConnector(); });
  }

  // ───────── 타임라인 (배포 진행 + PR) ─────────
  function tms(iso) { if (!iso) return null; const t = new Date(iso).getTime(); return isNaN(t) ? null : t; }
  function fmtMs(ms) { return fmtTime(new Date(ms).toISOString()); }
  const TL_WEEK = 7 * 24 * 3600 * 1000;
  const DAY_MS = 24 * 3600 * 1000;
  // 시간축 도메인[t0,t1]을 자정 경계로 나눈 "일별 구간" 띠 레이어. 각 띠는 pos()% 로 배치, 교대 배경 + 날짜 라벨.
  //   레이어 가로 위치(axis 정렬)는 렌더 후 rAF 에서 첫 axis 의 offset 으로 보정한다.
  function buildDayBands(pos, t0, t1) {
    if (t0 == null || t1 == null || !(t1 > t0)) return null;
    if ((t1 - t0) / DAY_MS > 45) return null;   // 범위가 너무 넓으면(데이터 sparse 등) 일별 띠 생략(과도한 DOM 방지)
    const layer = el('div', 'dep-tl-days');
    const midnight = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
    let day = midnight(t0), i = 0;
    while (day <= t1) {
      const l = pos(Math.max(day, t0)), r = pos(Math.min(day + DAY_MS, t1));
      if (r > l + 0.01) {
        const band = el('div', 'dep-tl-day' + (i % 2 ? ' alt' : '') + (i ? '' : ' first'));
        band.style.left = l + '%'; band.style.width = (r - l) + '%';
        const dt = new Date(day);
        band.innerHTML = `<span class="dep-tl-day-label">${dt.getMonth() + 1}/${dt.getDate()} (${DOW[dt.getDay()]})</span>`;
        layer.appendChild(band); i++;
      }
      day += DAY_MS;
    }
    return i ? layer : null;
  }
  // 배포 진행 캡션 겹침 방지: 캡션 실제 너비를 측정해 가로로 충돌하면 위/아래 + 여러 단(lane)으로 쌓는다.
  //   낮은 단·아래쪽을 선호(cost)해 평소엔 한 줄, 몰릴 때만 번갈아 위/아래로 분산 → 가로 겹침 제거.
  //   단 수에 맞춰 행(dep-tl-deploy) padding 을 키워 캡션이 인접 행을 침범하지 않게 한다.
  function layoutDeployCaps(axis) {
    const caps = [...axis.querySelectorAll('.dep-tl-cap')];
    if (!caps.length) return;
    const arect = axis.getBoundingClientRect();
    const capH = caps[0].offsetHeight || 28, ROW = capH + 4;
    const items = caps.map((c) => { const r = c.getBoundingClientRect();
      return { c, center: r.left + r.width / 2 - arect.left, half: r.width / 2 + 6 }; })
      .sort((a, b) => a.center - b.center);
    const lanes = { down: [], up: [] };
    let maxDown = 0, maxUp = 0;
    for (const it of items) {
      const min = it.center - it.half, max = it.center + it.half;
      let pick = null;
      for (const side of ['down', 'up']) {
        const L = lanes[side]; let li = 0;
        for (; li < L.length; li++) if (L[li].every(([a, b]) => max < a || min > b)) break;
        const cost = li * 2 + (side === 'up' ? 1 : 0);
        if (!pick || cost < pick.cost) pick = { side, li, cost };
      }
      const { side, li } = pick;
      (lanes[side][li] || (lanes[side][li] = [])).push([min, max]);
      it.c.classList.remove('up', 'down'); it.c.classList.add(side);
      const off = 14 + li * ROW;
      if (side === 'down') { it.c.style.top = off + 'px'; it.c.style.bottom = ''; maxDown = Math.max(maxDown, li); }
      else { it.c.style.bottom = off + 'px'; it.c.style.top = ''; maxUp = Math.max(maxUp, li); }
    }
    const row = axis.closest('.dep-tl-row');
    if (row) { row.style.paddingTop = (14 + maxUp * ROW + capH) + 'px';
      row.style.paddingBottom = (14 + maxDown * ROW + capH) + 'px'; }
  }
  // 타임라인·PR목록 공통 선택: 각 repo 의 pulls 인덱스(<repo>.pulls.json 의 pulls[])에서 표시할 PR 을 고른다.
  //   deploy_list 의 prs 는 사용하지 않는다. 후보 시각: status=merged → mergedAt, status=open → updatedAt
  //   (status 없는 구포맷은 mergedAt→updatedAt 폴백).
  //   선택 규칙: release_version 에 배포 커밋 SHA 가 있고 그 PR(mergeCommit)을 찾으면 → 그 배포 PR + 직전 2개 = 총 3개.
  //     그 외(latest/미매칭): 신청 전 1주 이내·최대 5건 + 신청~배포(진행/수정 중 가장 미래) 구간 전체
  //     (신청==배포 로 구간이 0 이 되는 경우 진행/수정까지 봐서 끝을 늘림. 신청/끝 시각 부족 시 최근 8건).
  //   repo 목록은 배포 task 에서 도출(같은 repo task 는 합쳐 1개, order 순).
  async function selectTimelinePulls(tk, seq) {
    const tl = tk.timeline || {};
    const reqAt = tms(tl.created && tl.created.at);     // 신청 시간
    const depAt = tms(tl.deployed && tl.deployed.at);   // 배포 시간
    // 구간 끝 경계: created_at==release_at 처럼 신청==배포 라 구간이 0 이 되면 PR 이 안 잡히므로
    //   진행(progress)·수정(modified)까지 보고 가장 미래 시각을 끝으로 쓴다.
    const laterAts = [depAt, tms(tl.progress && tl.progress.at), tms(tl.modified && tl.modified.at)].filter((v) => v != null);
    const endAt = laterAts.length ? Math.max(...laterAts) : null;
    const metaByRepo = await loadPullsForTicket(tk);
    if (renderSeq !== seq) return null;
    const repoTasks = [];
    for (const t of (tk.tasks || [])) {
      const ex = repoTasks.find((x) => x.repo === t.repo);
      if (!t.repo) continue;
      if (ex) { if (!ex.deployedCommit && t.deployedCommit) ex.deployedCommit = t.deployedCommit; }
      else repoTasks.push({ org: t.org, repo: t.repo, deployedCommit: t.deployedCommit || null });
    }
    const perRepo = repoTasks.map(({ org, repo, deployedCommit }) => {
      const meta = metaByRepo.get(RK(org, repo));
      const indexList = (meta && meta.list) || [];                      // <repo>.pulls.json 의 pulls[]
      const cand = new Map();
      for (const e of indexList) {
        const at = tms(e.status === 'open' ? e.updatedAt : (e.mergedAt || e.updatedAt));
        if (at == null) continue;
        // prCard 가 쓰는 필드명(merged_at/user/html_url)으로 매핑 + 타임라인용 at·mergeCommit 동봉.
        cand.set(String(e.number), { number: e.number, title: e.title, at,
          user: e.author, merged_at: e.mergedAt, html_url: e.url, status: e.status,
          mergeCommit: e.mergeCommit || '', _org: org, _repo: repo });
      }
      const prs = [...cand.values()].sort((a, b) => a.at - b.at);
      // 배포된 이미지 커밋(release_version 의 SHA)과 mergeCommit prefix 매칭 → 해당 PR 에 배포 표시.
      const di = deployedCommit ? prs.findIndex((p) => p.mergeCommit && p.mergeCommit.toLowerCase().startsWith(deployedCommit)) : -1;
      if (di >= 0) prs[di].deployed = true;
      let shown;
      if (di >= 0) {
        // release_version 이 가리키는 배포 커밋 PR + 직전 2개 = 총 3개만 표시.
        shown = prs.slice(Math.max(0, di - 2), di + 1);
      } else if (reqAt != null && endAt != null) {
        const before = prs.filter((p) => p.at < reqAt && p.at >= reqAt - TL_WEEK).slice(-5);  // 신청 전 1주 이내 · 최대 5건
        const within = prs.filter((p) => p.at >= reqAt && p.at <= endAt);                     // 신청~배포(진행/수정 중 최후) 구간 전체
        shown = [...before, ...within];
      } else shown = prs.slice(-8);   // 타임라인 시각(신청/배포) 부족 시 최근 8개
      return { org, repo, deployedCommit, shown };
    });
    return { reqAt, depAt, perRepo };
  }
  async function renderTimelines(host, tk, ctx, seq) {
    const tl = tk.timeline || {};
    const sel = await selectTimelinePulls(tk, seq);
    if (!sel || renderSeq !== seq) return;
    const { reqAt, depAt, perRepo } = sel;

    // 배포 진행 노드
    const dnodes = ['created', 'approved', 'deployed', 'progress', 'modified']
      .map((key) => tl[key]).filter((n) => n && tms(n.at) != null)
      .map((n) => ({ key: n.key, label: n.label, by: n.by, at: tms(n.at) }));

    // 시간축 — 배포 신청(reqAt)을 정가운데(50%)에 고정.
    //   왼쪽 [신청-1주, 신청] → [0,50] (1주 이내 PR), 오른쪽 [신청, 우측끝] → [50,100] (승인/배포/수정 + 구간 PR)
    let pos, domainMin, domainMax;
    if (reqAt != null) {
      const rightAts = [depAt, ...dnodes.map((n) => n.at), ...perRepo.flatMap((r) => r.shown.map((p) => p.at))]
        .filter((v) => v != null && v > reqAt);
      const rightMax = Math.max(reqAt + 3600e3, ...rightAts);
      const L0 = (reqAt - TL_WEEK) - TL_WEEK * 0.05, R1 = rightMax + (rightMax - reqAt) * 0.06;
      domainMin = L0; domainMax = R1;
      pos = (t) => t <= reqAt
        ? Math.max(0, Math.min(50, 50 * (t - L0) / (reqAt - L0)))
        : Math.max(50, Math.min(100, 50 + 50 * (t - reqAt) / (R1 - reqAt)));
    } else {
      const stamps = [...dnodes.map((n) => n.at), ...perRepo.flatMap((r) => r.shown.map((p) => p.at))];
      if (depAt != null) stamps.push(depAt);
      if (!stamps.length) { host.innerHTML = '<div class="dep-hint">타임라인 데이터가 없습니다.</div>'; return; }
      let t0 = Math.min(...stamps), t1 = Math.max(...stamps); if (t1 === t0) t1 = t0 + 1;
      const pad = (t1 - t0) * 0.05; t0 -= pad; t1 += pad;
      domainMin = t0; domainMax = t1;
      pos = (t) => Math.max(0, Math.min(100, ((t - t0) / (t1 - t0)) * 100));
    }

    host.innerHTML = '';
    // 일별 구간 배경 — 자정 경계로 나눈 날짜 띠 + 날짜 라벨(겹치는 시간축에서 어느 날인지 식별). 행 뒤(z-index:0)에 깔린다.
    const daysLayer = buildDayBands(pos, domainMin, domainMax);
    if (daysLayer) host.appendChild(daysLayer);
    // 배포 진행 타임라인 — 캡션을 위/아래 번갈아 배치(텍스트 겹침 방지)
    const dRow = el('div', 'dep-tl-row dep-tl-deploy');
    dRow.appendChild(el('div', 'dep-tl-rowlabel', '배포'));
    const dAxis = el('div', 'dep-tl-axis');
    dAxis.appendChild(el('div', 'dep-tl-line'));
    dnodes.forEach((n, i) => {
      const node = el('div', 'dep-tl-node st-' + n.key);
      node.style.left = pos(n.at) + '%';
      node.innerHTML = `<span class="dep-tl-dot"></span>` +
        `<span class="dep-tl-cap ${i % 2 ? 'up' : 'down'}"><b>${FM.esc(n.label)}</b>${n.by ? ' · ' + FM.esc(n.by) : ''}` +
        `<span class="dep-tl-t">${FM.esc(fmtMs(n.at))}</span></span>`;
      dAxis.appendChild(node);
    });
    dRow.appendChild(dAxis);
    host.appendChild(dRow);

    // repo 별 PR 타임라인 ("{repo} pr")
    for (const { repo, shown } of perRepo) {
      const pRow = el('div', 'dep-tl-row');
      pRow.appendChild(el('div', 'dep-tl-rowlabel', `${repo} pr`));
      const pAxis = el('div', 'dep-tl-axis');
      pAxis.appendChild(el('div', 'dep-tl-line'));
      if (reqAt != null) { const m = el('div', 'dep-tl-bound req'); m.style.left = pos(reqAt) + '%'; m.title = '신청'; pAxis.appendChild(m); }
      if (depAt != null) { const m = el('div', 'dep-tl-bound dep'); m.style.left = pos(depAt) + '%'; m.title = '배포'; pAxis.appendChild(m); }
      if (!shown.length) pAxis.appendChild(el('div', 'dep-tl-empty', 'PR 없음'));
      for (const p of shown) {
        const isBefore = reqAt != null && p.at < reqAt;
        const dot = el('div', 'dep-tl-pr-dot' + (isBefore ? ' before' : ' within') +
          (p.deployed ? ' deployed' : '') + (String(p.number) === String(ctx.sel) ? ' sel' : ''));
        dot.style.left = pos(p.at) + '%';
        dot.dataset.pr = p.number;   // 하단 PR 목록 카드(data-pr)와 연결용
        // hover 시 박스로 표시 — 점이 겹쳐도 내용이 위에 또렷이 뜬다(native title 대신 스타일 박스).
        dot.innerHTML = `<span class="dep-tl-pr-cap"><b>#${p.number}</b> ${FM.esc(p.title || '')}` +
          `<span class="dep-tl-t">${FM.esc(repo)} · ${FM.esc(fmtMs(p.at))}${p.deployed ? ' · 🚀 배포됨' : ''}</span></span>`;
        dot.onclick = () => nav({ y: ctx.y, d: ctx.d, t: ctx.t, pr: String(p.number) });
        pAxis.appendChild(dot);
      }
      pRow.appendChild(pAxis);
      host.appendChild(pRow);
    }
    // 범례는 섹션 제목 우측 끝 슬롯(dep-tl-legend)에 채운다.
    const anyDeployed = perRepo.some((r) => r.shown.some((p) => p.deployed));
    const sec = host.closest('.dep-timeline-sec');
    const legendEl = sec && sec.querySelector('.dep-tl-legend');
    if (legendEl) legendEl.innerHTML =
      `<span class="dep-tl-lg before">●</span> 신청 전(1주·최대 5) &nbsp; <span class="dep-tl-lg within">●</span> 신청~배포 구간` +
      (anyDeployed ? ` &nbsp; <span class="dep-tl-lg deployed">●</span> 🚀 배포된 이미지(commit)` : '');
    // 타임라인이 비동기로 채워지며 레이아웃이 밀리면 서비스 영향도 커넥터도 어긋난다 → 확정 후 재그리기.
    //   (일별 띠 가로정렬은 CSS calc 로 axis 컬럼에 고정 — 리사이즈 자동 추종, JS px 보정 불필요)
    requestAnimationFrame(() => {
      const dAxis = host.querySelector('.dep-tl-deploy .dep-tl-axis');
      if (dAxis) layoutDeployCaps(dAxis);    // 배포 진행 캡션 겹침 해소(행 높이 변동 → 커넥터보다 먼저)
      FM.drawConnectors(); drawPrConnector();
    });
  }

  // 선택된 PR 의 타임라인 점과 하단 PR 목록 카드를 곡선으로 잇는다(같은 data-pr). dep-main 스크롤/리사이즈 시 재계산.
  function drawPrConnector() {
    const main = depMain; if (!main) return;
    let svg = main.querySelector(':scope > svg.dep-conn');
    const dot = main.querySelector('.dep-tl-pr-dot.sel');
    const card = main.querySelector('.dep-prc.sel');
    if (!dot || !card) { if (svg) svg.remove(); return; }
    if (!svg) { svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'dep-conn'); main.appendChild(svg); }
    svg.setAttribute('width', main.scrollWidth); svg.setAttribute('height', main.scrollHeight);
    // 화면 좌표(getBoundingClientRect)를 SVG user 좌표로 역변환 — 조상 zoom(줌 컨트롤)·스크롤·transform 을 한 번에 보정.
    //   (예전엔 getBoundingClientRect 차이를 그대로 user 좌표로 썼는데, SVG 가 zoom 으로 또 축소돼 선이 점·카드에서 어긋났음.)
    const ctm = svg.getScreenCTM(); if (!ctm) return;
    const inv = ctm.inverse(), pt = svg.createSVGPoint();
    const toLocal = (cx, cy) => { pt.x = cx; pt.y = cy; const p = pt.matrixTransform(inv); return p; };
    const dr = dot.getBoundingClientRect(), cr = card.getBoundingClientRect();
    const a = toLocal(dr.left + dr.width / 2, dr.bottom), b = toLocal(cr.left + 18, cr.top);
    const x1 = a.x, y1 = a.y, x2 = b.x, y2 = b.y;
    const my = (y1 + y2) / 2;
    svg.innerHTML = `<path d="M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}" fill="none" stroke="#f59e0b" stroke-width="2" stroke-dasharray="5 3"/>`
      + `<circle cx="${x1}" cy="${y1}" r="3.5" fill="#f59e0b"/><circle cx="${x2}" cy="${y2}" r="3.5" fill="#f59e0b"/>`;
  }

  function prCard(p, ctx) {
    const on = ctx && String(p.number) === String(ctx.sel);
    const merged = !!p.merged_at;       // 머지 시각이 있으면 머지된 PR
    const unmerged = isUnmergedPr(p);   // 메타가 있는데 mergedAt 만 없을 때만 "미머지"로 확정(number-only 는 미확정)
    const card = el('div', 'dep-prc' + (on ? ' sel' : '') + (unmerged ? ' warn' : '') + (p.deployed ? ' deployed' : ''));
    card.dataset.pr = p.number;   // 타임라인 점(data-pr)과 연결용
    const num = p.number != null ? '#' + p.number : '';
    const warnBadge = unmerged ? '<span class="dep-prc-warn" title="Not merged — verify it is actually included in this deploy">⚠️</span>' : '';
    const deployBadge = p.deployed ? '<span class="dep-prc-dep" title="이 PR의 커밋이 배포된 이미지입니다">🚀</span>' : '';
    // PR 상태 배지(merged/open/closed/draft) — pulls 인덱스의 status. 없으면(번호만) 미표시.
    const ST = { merged: 'Merged', open: 'Open', closed: 'Closed', draft: 'Draft' };
    const stKey = String(p.status || '').toLowerCase();
    const stBadge = ST[stKey] ? `<span class="dep-prc-st st-${stKey}">${ST[stKey]}</span>` : '';
    const time = merged ? FM.esc(fmtTime(p.merged_at)) : '';
    const meta = [p.user ? FM.esc(p.user) : '', time].filter(Boolean).join(' · ');
    // 2줄 카드 — 위: PR번호·상태·배지 + (배포자·시간) + GitHub / 아래: 제목
    card.innerHTML =
      `<div class="dep-prc-top">` +
        `<span class="dep-prc-num">PR ${FM.esc(num)}</span>${warnBadge}${deployBadge}${stBadge}` +
        `<span class="dep-prc-by">${meta}</span>` +
        (p.html_url ? `<a class="dep-prc-gh" href="${FM.escAttr(p.html_url)}" target="_blank" rel="noopener noreferrer" title="GitHub에서 PR 보기">↗</a>` : '') +
      `</div>` +
      `<div class="dep-prc-title">${FM.esc(p.title || '')}</div>`;
    // PR 클릭 → 배포 영향도 안에서 pr= 선택 (커밋 영향도 뷰로 이동하지 않음). GitHub 링크는 통과.
    const go = (ev) => { if (ev.target.closest('.dep-prc-gh')) return; if (p.number != null) nav({ y: ctx.y, d: ctx.d, t: ctx.t, pr: String(p.number) }); };
    card.onclick = go;
    return card;
  }

})();
