/* flowmap 기능 모듈: git 커밋 영향도 분석 (view=commits)
 * 계약: docs/FEATURE-API.md — window.Flowmap API 표면만 사용한다. */
(() => {
  'use strict';
  const FM = window.Flowmap;
  const DATA_URL = 'data/impact.json';
  const MAX_NODES = 200;   // 노드 폭증 가드 (기존 200호출 상한과 동일 정책)
  const MAX_HOP = 3;       // 경계 투영 최대 표시 단계 (1/2/3차 버튼 상한)
  let hopDepth = 1;        // 현재 표시 단계 — 기본 1차(직접 변경 엔드포인트 + 1차 연결 포인트만)

  // 커밋 링크 — impact.json이 커밋마다 제공하는 commitUrl(저장소의 해당 커밋 페이지)을 그대로 쓴다.
  // 없으면 top-level repoUrl + '/commit/<sha>' 로 폴백, 그것도 없으면 링크 버튼을 숨긴다.
  function commitUrl(c) {
    if (!c) return null;
    if (c.commitUrl) return c.commitUrl;
    if (c._repoUrl && c.sha) return c._repoUrl.replace(/\/+$/, '') + '/commit/' + c.sha;
    return null;
  }

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
  const WD = ['일', '월', '화', '수', '목', '금', '토'];
  // 날짜 그룹 헤더용 — "2026-06-02 (월)"
  function fmtDay(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} (${WD[d.getDay()]})`;
  }
  // 커밋 행 시각 — "20:47"
  function fmtTime(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  // 프로젝트명 → 고정 색상(hue). 같은 프로젝트는 항상 같은 색.
  // 접두사가 비슷해도(예: tera-cloud-*) 잘 흩어지도록 FNV-1a 해시로 섞는다.
  function projectHue(name) {
    let h = 2166136261;
    for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0) % 360;
  }

  // PR 식별자('PR<번호>')는 화면에 '#<번호>'로 표시한다 (커밋 shortSha는 그대로).
  function shaLabel(sha) { return /^PR\d+$/.test(sha) ? '#' + sha.slice(2) : sha; }
  function shaChip(sha) {
    return `<span class="imp-sha">◆ ${FM.esc(shaLabel(sha))}</span>`;
  }

  // 프론트엔드 프로젝트 집합 — 프론트의 API 호출(EXTERNAL) 노드는 백엔드 endpoint와 join 으로 묶인
  // "배선"일 뿐이므로 경계로 치지 않고 접어서 화면(SCREEN)까지 도달시킨다.
  let _frontProjects;
  function frontProjects() {
    if (!_frontProjects) {
      _frontProjects = new Set(((FM.MANIFEST && FM.MANIFEST.projects) || [])
        .filter(p => p.type === 'frontend').map(p => p.name));
    }
    return _frontProjects;
  }

  // 경계 노드 = 어플리케이션 경계를 드러내는 노드만 표시 대상으로 삼는다:
  //   SCREEN(화면) · CONTROLLER(endpoint 단위·s2s 대상) · 백엔드 EXTERNAL(외부 API) · kafka 토픽(서비스 간 이벤트).
  //   그 외(SERVICE/COMPONENT/REPOSITORY/STORE/CONFIG/프론트 API 콜/…)는 내부 배선이라 접어 숨긴다.
  function isBoundary(id) {
    const n = FM.nodeById.get(id);
    if (!n) return false;
    if (n.layer === 'SCREEN' || n.layer === 'CONTROLLER') return true;
    if (n.layer === 'EXTERNAL') return !frontProjects().has(n.project);
    return n.layer === 'RESOURCE';   // db-table·redis·kafka-topic = 인프라 경계(유출측)
  }

  // 영향 대상의 종류 — 프론트 그래프의 진입점은 화면(SCREEN), 백엔드는 엔드포인트(CONTROLLER).
  // impactedEndpoints 슬롯을 프론트는 SCREEN 으로 채우므로, 백엔드/프론트가 한 타임라인에
  // 병합돼도 노드 레이어로 라벨을 구분한다(데이터 구조는 동일, 표시 명사만 다름).
  function isScreenId(id) {
    const n = FM.nodeById.get(id);
    return !!(n && n.layer === 'SCREEN');
  }
  function targetNoun(id) { return isScreenId(id) ? '화면' : '엔드포인트'; }
  // 한 집합(행 목록/레벨)의 대표 명사 — 모두 화면이면 '화면', 모두 엔드포인트면 '엔드포인트', 섞이면 '대상'.
  function nounOf(ids) {
    let s = false, e = false;
    for (const id of ids) { if (isScreenId(id)) s = true; else e = true; if (s && e) break; }
    return s && !e ? '화면' : e && !s ? '엔드포인트' : '대상';
  }

  /* ───────── 영향 전파 ─────────
   * 영향 엔드포인트(impactedEndpoints)는 백엔드가 PR별로 사전계산해 인덱스에 넣어준다 —
   * 목록 "영향 N"·미선택 집계표는 샤드 없이 인덱스만으로 그린다. 변경 시드(changedApiMethods,
   * 비-private)는 샤드에 있고 그래프 뷰(커밋 클릭)에서 "수정된 메서드" 강조에만 쓰인다. */

  // 커밋이 영향 주는 엔드포인트(레퍼런스 배열) — 인덱스 사전계산값.
  function commitImpactedEndpoints(c) { return (c && c.impactedEndpoints) || []; }

  // 집계: 엔드포인트 → 영향 준 커밋 목록(역인덱스). 인덱스의 PR별 impactedEndpoints 를 뒤집는다.
  function getEndpointImpact() {
    if (data._endpointImpact) return data._endpointImpact;
    const byEp = new Map();   // epId -> { ref, shas:Set }
    (data.commits || []).forEach(c => {
      commitImpactedEndpoints(c).forEach(ep => {
        if (!byEp.has(ep.id)) byEp.set(ep.id, { ref: ep, shas: new Set() });
        byEp.get(ep.id).shas.add(c.shortSha);
      });
    });
    data._endpointImpact = [...byEp.values()]
      .map(({ ref, shas }) => Object.assign({}, ref, { commits: [...shas] }))
      .sort((a, b) => b.commits.length - a.commits.length);
    return data._endpointImpact;
  }

  // 그래프 뷰의 "수정된 public 메서드(비-private)" 강조 시드 — 샤드(상세)의 changedApiMethods.
  function changedSeedIds(c) {
    const seeds = commitDetail(c).changedApiMethods || c.changedApiMethods || c.changedPublicMethods;
    if (Array.isArray(seeds) && seeds.length) return seeds.filter(id => FM.nodeById.has(id));
    // 폴백(구 스키마): changedNodes 에서 비-private 추출.
    const cn = commitDetail(c).changedNodes;
    const hasVis = cn.some(n => n.visibility != null);
    const pick = hasVis ? cn.filter(n => n.visibility !== 'private') : cn;
    return pick.filter(n => n.inGraph).map(n => n.id).filter(id => FM.nodeById.has(id));
  }

  // 매니페스트가 있으면 프로젝트별 <project>.impact.json 들을 병합, 없으면 단일 impact.json 폴백
  function impactFiles() {
    const projs = FM.MANIFEST && FM.MANIFEST.projects;
    if (projs && projs.length) {
      const files = projs.filter(p => p.impact).map(p => p.impact);
      return files.length ? files : null;   // 매니페스트는 있으나 impact 없음 → 빈 상태
    }
    return [DATA_URL.replace('data/', '')];
  }
  // PR 기반 impact.json(pulls/base/pullCount)을 커밋 기반 형태(commits/branch/commitCount)로 정규화.
  // 두 스키마를 한 타임라인에 섞어 보여주기 위해 PR을 "커밋처럼" 매핑한다.
  //   - shortSha 키: 'PR<번호>' (URL-안전), 화면 표시는 '#<번호>'
  //   - 링크: repoUrl + '/pull/<번호>'
  //   - endpointImpact[].pulls(정수 PR번호) → .commits(['PR<번호>']) 로 키 정렬
  function normalizePart(part) {
    if (!part || Array.isArray(part.commits) || !Array.isArray(part.pulls)) return part;
    const repo = part.repoUrl ? part.repoUrl.replace(/\/+$/, '') : '';
    part.branch = part.base;
    part.commitCount = part.pullCount != null ? part.pullCount : part.pulls.length;
    part.commits = part.pulls.map(p => {
      // 인덱스(목록)에는 시드 id(changedApiMethods=비-private)와 카운트만 — 무거운 changedNodes는
      // PR별 샤드(<base>.impact/<번호>.json)에 있고 커밋 클릭 시 lazy 로드한다.
      const c = {
        sha: p.mergeCommit,
        shortSha: 'PR' + p.number,
        author: p.author,
        date: p.mergedAt,
        subject: p.title,
        commitUrl: repo ? repo + '/pull/' + p.number : null,
        changedNodeCount: p.changedNodeCount != null ? p.changedNodeCount
          : (Array.isArray(p.changedNodes) ? p.changedNodes.length : 0),
        changedFileCount: p.changedFileCount != null ? p.changedFileCount
          : (Array.isArray(p.changedFiles) ? p.changedFiles.length : 0),
        impactedEndpoints: p.impactedEndpoints || [],   // 백엔드 사전계산 (목록/집계용)
        _pull: p.number,
      };
      // 구(舊) 인라인 스키마(changedNodes/Files 포함)면 상세를 이미 가진 것으로 취급 — 샤드 페치 생략.
      if (Array.isArray(p.changedNodes) || Array.isArray(p.changedFiles)) {
        c._detail = {
          changedNodes: p.changedNodes || [],
          changedApiMethods: p.changedApiMethods || p.changedPublicMethods || [],
          changedFiles: p.changedFiles || [],
          deletedNodes: p.deletedNodes || [],
          deletedEndpoints: p.deletedEndpoints || [],
        };
        c._detailLoaded = true;
      }
      return c;
    });
    // impactedEndpoints / endpointImpact 는 백엔드가 더 이상 주지 않는다 — UI 가 live BFS 로 만든다.
    return part;
  }
  function mergeImpact(parts) {
    const out = { branch: parts[0].branch, commits: [],
      commitCount: 0, changedNodeCount: 0, deletedEndpointCount: 0, breakingDeletionCount: 0 };
    for (const p of parts) {
      if (Array.isArray(p.commits)) out.commits.push(...p.commits);
      out.commitCount += p.commitCount || (p.commits ? p.commits.length : 0);
      out.changedNodeCount += p.changedNodeCount || 0;
      out.deletedEndpointCount += p.deletedEndpointCount || 0;
      out.breakingDeletionCount += p.breakingDeletionCount || 0;
    }
    return out;
  }

  async function ensureData() {
    if (data === undefined) {
      const files = impactFiles();
      if (!files) { data = null; return data; }
      const parts = (await Promise.all(files.map(async f => {
        const part = normalizePart(await FM.fetchData('data/' + f));   // PR 기반이면 커밋 형태로 정규화
        // 커밋에 출처 프로젝트/저장소를 태깅 — 병합 후에도 프로젝트 칩·커밋 링크를 만들 수 있도록.
        // 프로젝트명은 repoUrl 마지막 경로, 없으면 파일명(<project>.impact.json)에서 유도.
        if (part && Array.isArray(part.commits)) {
          const proj = part.repoUrl
            ? part.repoUrl.replace(/\/+$/, '').split('/').pop()
            : f.split('/').pop().replace(/\.impact\.json$/, '');   // 폴더 레이아웃(projects/<svc>/<svc>.impact.json) → 베이스명만
          const shardBase = f.replace(/\.json$/, '');   // "<...>/<project>.impact" — 샤드 디렉터리 베이스(상대경로 유지)
          part.commits.forEach(c => {
            if (part.repoUrl && !c._repoUrl) c._repoUrl = part.repoUrl;
            if (!c._project) c._project = proj;
            if (!c._shardBase) c._shardBase = shardBase;
          });
        }
        return part;
      }))).filter(Boolean);
      data = parts.length ? mergeImpact(parts) : null;
      if (data && Array.isArray(data.commits)) {
        // 최근 날짜순(내림차순) 정렬 — 여러 프로젝트가 병합되어도 한 타임라인으로 보이도록
        data.commits.sort((a, b) => new Date(b.date) - new Date(a.date));
        data.commits.forEach(c => commitBySha.set(c.shortSha, c));
      }
    }
    return data;
  }

  /* ───────── 커밋 상세 lazy 로딩 ─────────
   * 인덱스에는 목록/시드만 있고 무거운 changedNodes 상세는 PR별 샤드에 있다.
   * 커밋을 열 때만 data/<base>.impact/<번호>.json 을 가져와 c._detail 에 붙인다(1회 캐시). */
  function commitDetail(c) {
    return (c && c._detail) || { changedNodes: [], changedApiMethods: [], changedFiles: [], deletedNodes: [], deletedEndpoints: [] };
  }
  async function ensureShard(c) {
    if (!c || c._detailLoaded) return;
    c._detailLoaded = true;   // 동시/중복 페치 가드 (실패해도 빈 상세로 둔다)
    if (!c._shardBase || c._pull == null) return;
    const s = await FM.fetchData(`data/${c._shardBase}/${c._pull}.json`);   // 404면 null
    if (s) c._detail = {
      changedNodes: s.changedNodes || [], changedApiMethods: s.changedApiMethods || [],
      changedFiles: s.changedFiles || [], deletedNodes: s.deletedNodes || [], deletedEndpoints: s.deletedEndpoints || [],
    };
  }
  function ensureShards(shas) {
    return Promise.all(shas.map(sha => ensureShard(commitBySha.get(sha))));
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
    // 재렌더 전 커밋 레일 스크롤 위치 보존 (클릭 시 맨 위로 튀지 않도록)
    const prevList = cols.querySelector('.imp-list');
    const prevScroll = prevList ? prevList.scrollTop : 0;
    cols.className = 'imp-view';
    cols.innerHTML = '';
    FM.setCanvasEdges([]);

    if (data === null) { drawBreadcrumb([]); renderMissing(cols); return; }

    const selected = parseSel();
    const ep = FM.param('ep') || '';
    drawBreadcrumb(selected);

    cols.appendChild(buildRail(selected));
    const newList = cols.querySelector('.imp-list');
    if (newList) newList.scrollTop = prevScroll;

    const main = el('div', 'imp-main');
    cols.appendChild(main);
    if (selected.length) {
      // 커밋 선택 시에만 그 PR들의 상세 샤드를 lazy 로드한 뒤 그래프를 그린다.
      const seq = renderSeq;
      const allLoaded = selected.every(s => (commitBySha.get(s) || {})._detailLoaded);
      const draw = () => {
        if (renderSeq !== seq) return;
        renderGraph(main, selected, ep);
        requestAnimationFrame(() => { FM.drawConnectors(); FM.applyHighlight(); });
      };
      if (allLoaded) { draw(); }
      else {
        main.innerHTML = '<div class="imp-loading">상세 불러오는 중…<div class="imp-skel"></div><div class="imp-skel"></div></div>';
        ensureShards(selected).then(() => { if (renderSeq === seq) { main.innerHTML = ''; draw(); } });
      }
    } else {
      renderAggregate(main, ep);
      requestAnimationFrame(() => { FM.drawConnectors(); FM.applyHighlight(); });
    }
  }

  function drawBreadcrumb(selected) {
    const bc = document.getElementById('breadcrumb');
    bc.style.display = 'flex';
    let html = '<span class="bc-link" data-imp-root>🧾 커밋 영향도</span>';
    if (selected.length) {
      html += '<span class="bc-sep">›</span>' +
        `<span class="bc-focus">◆ ${FM.esc(shaLabel(selected[0]))}${selected.length > 1 ? ` (+${selected.length - 1})` : ''}</span>`;
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
      `<div class="imp-rail-title">변경이력 <span class="grid-count">${FM.esc(String(data.commitCount))}</span></div>`);
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

    // 날짜(일자)별 그룹 헤더를 끼워가며 커밋을 타임라인으로 렌더
    let lastDay = null;
    data.commits.forEach(c => {
      const day = fmtDay(c.date);
      if (day !== lastDay) {
        const hdr = el('div', 'imp-datehdr', FM.esc(day));
        hdr.dataset.day = day;
        list.appendChild(hdr);
        lastDay = day;
      }
      list.appendChild(commitCard(c, selSet));
    });

    const apply = () => {
      const q = railFilter.trim().toLowerCase();
      let shown = 0;
      const dayShown = {};
      list.querySelectorAll('.imp-commit').forEach(card => {
        const hit = !q || card.dataset.search.includes(q);
        card.style.display = hit ? '' : 'none';
        if (hit) { shown++; dayShown[card.dataset.day] = true; }
      });
      // 보이는 커밋이 없는 날짜 헤더는 숨긴다
      list.querySelectorAll('.imp-datehdr').forEach(h => {
        h.style.display = dayShown[h.dataset.day] ? '' : 'none';
      });
      empty.style.display = shown ? 'none' : '';
    };
    filter.oninput = () => { railFilter = filter.value; apply(); };
    apply();
    return rail;
  }

  function commitCard(c, selSet) {
    const on = selSet.has(c.shortSha);
    const card = el('div', 'imp-commit' + (on ? ' on' : ''));
    card.dataset.search =
      (c.author + ' ' + c.subject + ' ' + c.shortSha).toLowerCase();   // 파일명은 샤드라 필터 제외
    card.dataset.day = fmtDay(c.date);

    const noCode = !c.changedNodeCount;
    const link = commitUrl(c);
    const proj = c._project || '';
    const h = projectHue(proj);
    const projChip = proj
      ? `<span class="imp-proj" title="${FM.escAttr(proj)}" ` +
        `style="color:hsl(${h} 55% 38%);border-color:hsl(${h} 50% 55% / .45);background:hsl(${h} 70% 55% / .12)">${FM.esc(proj)}</span>`
      : '';
    card.innerHTML =
      `<span class="imp-dot" style="background:hsl(${h} 60% 62%)"></span>` +
      `<div class="imp-cbody">` +
        `<div class="imp-crow1">${projChip}<span class="imp-csha">${FM.esc(c._pull != null ? '#' + c._pull : c.shortSha)}</span>` +
          `<span class="imp-time">${FM.esc(fmtTime(c.date))}</span></div>` +
        `<div class="imp-csubj" title="${FM.escAttr(c.subject)}">${FM.esc(c.subject)}</div>` +
        (c.author ? `<div class="imp-cauthor">👤 ${FM.esc(c.author)}</div>` : '') +
        `<div class="imp-cchips">` +
          (noCode
            ? `<span class="imp-cc none">코드 영향 없음</span><span class="imp-cc">파일 ${c.changedFileCount}</span>`
            : `<span class="imp-cc chg">◆ 변경 <b>${c.changedNodeCount}</b></span>` +
              `<span class="imp-cc imp">◇ 영향 <b>${commitImpactedEndpoints(c).length}</b></span>`) +
        `</div>` +
      `</div>` +
      (link
        ? `<a class="imp-clink" href="${FM.escAttr(link)}" target="_blank" rel="noopener noreferrer" title="저장소에서 이 커밋 보기">↗</a>`
        : '');

    // 링크 버튼 클릭은 카드 선택으로 번지지 않게 한다
    const a = card.querySelector('.imp-clink');
    if (a) a.onclick = e => e.stopPropagation();
    // 카드 클릭 = 단일 선택 (기존 선택 대체)
    card.onclick = () => pushSel([c.shortSha], '');
    return card;
  }

  /* ───────── 커밋 미선택: endpointImpact 집계 테이블 ───────── */

  function renderAggregate(main, ep) {
    FM.setProcessDockEnabled(false);   // 커밋 미선택 — 하단 프로세스 독 숨김
    FM.state.sel = null; FM.renderDetail();   // 그래프 선택 패널도 닫음

    // 상단 타이틀 + 통계 숫자 카드 (FLOW MAP "Impact Flow" 헤더 스타일)
    main.appendChild(el('div', 'imp-flowhead',
      `<div class="imp-flowtitle">${FM.esc(data.branch)} — 변경 영향도</div>` +
      `<div class="imp-flowsub">최근 ${FM.esc(String(data.commitCount))}건 변경이력 · 공개 메서드 기준 호출그래프 역추적 | 화면→서비스→인프라 영향 분석</div>`));

    const epRows = getEndpointImpact();
    const epCount = epRows.length;
    // 데이터 구성에 따라 명사 적응 — 프론트만 병합됐으면 "영향 화면", 백엔드면 "영향 엔드포인트".
    const allNoun = nounOf(epRows.map(r => r.id));
    const statCards = [
      { n: data.commitCount, label: '변경이력', cls: 'a' },
      { n: data.changedNodeCount, label: '변경 노드', cls: 'b' },
      { n: epCount, label: '영향 ' + allNoun, cls: 'c' },
      { n: data.deletedEndpointCount || 0, label: '삭제 API', cls: 'd' },
      { n: data.breakingDeletionCount || 0, label: 'Breaking', cls: 'e' },
    ];
    main.appendChild(el('div', 'imp-stats',
      statCards.map(s =>
        `<div class="imp-statcard imp-stat-${s.cls}"><div class="imp-statnum">${FM.esc(String(s.n))}</div>` +
        `<div class="imp-statlabel">${FM.esc(s.label)}</div></div>`).join('')));
    main.appendChild(el('div', 'hint imp-flowhint', '왼쪽 타임라인에서 변경이력을 선택하면 그 변경이 닿는 영향 그래프가 펼쳐집니다.'));

    let rows = getEndpointImpact().slice();   // 이미 영향 커밋 수 내림차순 정렬됨

    if (ep) {
      const chip = el('div', 'imp-epfilter',
        `${FM.esc(targetNoun(ep))} 필터: <code>${FM.esc(ep)}</code> <button class="btn imp-x" title="필터 해제">✕</button>`);
      chip.querySelector('button').onclick = () => pushSel([], '');
      main.appendChild(chip);
      rows = rows.filter(r => r.id === ep);
    }

    if (!rows.length) {
      main.appendChild(el('div', 'browse-empty imp-empty',
        `<div class="be-ico">◇</div><div class="be-msg">영향받는 ${FM.esc(allNoun)}이 없습니다</div>`));
      return;
    }

    const table = el('div', 'imp-table');
    table.appendChild(el('div', 'imp-trow imp-thead',
      `<span class="imp-tep">영향 ${FM.esc(nounOf(rows.map(r => r.id)))}</span><span class="imp-tsvc">서비스</span><span class="imp-tcommits">영향 변경이력</span>`));

    rows.forEach(r => {
      const row = el('div', 'imp-trow');
      // 프론트 화면은 HTTP 동사가 없으므로 메서드 배지 대신 화면 배지를 단다.
      const badge = isScreenId(r.id)
        ? '<span class="nc-badge screen">화면</span>'
        : (() => { const m = (r.httpMethod || 'ANY').toUpperCase(); return `<span class="nc-badge http ${FM.methodClass(m)}">${FM.esc(m)}</span>`; })();
      row.innerHTML =
        `<span class="imp-tep">${badge}` +
        `<code class="imp-path-code" title="${FM.escAttr(r.id)}">${FM.esc(r.endpoint || r.id)}</code>` +
        (r.description ? `<span class="imp-tdesc">${FM.esc(r.description)}</span>` : '') + `</span>` +
        `<span class="imp-tsvc">${FM.esc(r.service || '')}</span>` +
        `<span class="imp-tcommits"></span>`;

      const cell = row.querySelector('.imp-tcommits');
      r.commits.forEach(sha => {
        const chip = el('button', 'imp-sha imp-sha-btn', `◆ ${FM.esc(shaLabel(sha))}`);
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

  function renderGraph(main, selected, ep, opts) {
    opts = opts || {};
    const prevSel = FM.state.sel;          // 단계 변경(재렌더) 시 선택 노드 유지용
    main.innerHTML = '';                    // 재호출(단계 전환) 시 이전 내용 비우고 다시 그림
    // 단계(1/2/3차) 버튼이 누르면 같은 컨테이너에 hopDepth 만 바꿔 다시 그린다.
    const rerender = () => {
      renderGraph(main, selected, ep, Object.assign({}, opts, { _keepSel: true }));
      requestAnimationFrame(() => { FM.drawConnectors(); FM.applyHighlight(); });
    };
    // 선택 커밋 합집합 수집
    const changedSha = new Map();   // nodeId -> [shortSha…]  (inGraph만)
    const outOfGraph = [];          // {id, sha}
    const epIds = new Set();        // 영향 엔드포인트 합집합
    const allFiles = [];            // {sha, file}
    selected.forEach(sha => {
      const c = commitBySha.get(sha);
      if (!c) return;
      commitDetail(c).changedNodes.forEach(n => {   // 샤드(상세)에서 — paint()가 렌더 전 lazy 로드
        if (!n.inGraph) { outOfGraph.push({ id: n.id, sha }); return; }
        if (!changedSha.has(n.id)) changedSha.set(n.id, []);
        changedSha.get(n.id).push(sha);
      });
      commitImpactedEndpoints(c).forEach(e => epIds.add(e.id));
      commitDetail(c).changedFiles.forEach(f => allFiles.push({ sha, file: f }));   // 샤드(상세)
    });

    const changedInGraph = [...changedSha.keys()].filter(id => FM.nodeById.has(id));

    // 노드를 눌러 프로세스 흐름(독)을 열면, 그 호출 체인 안에서 "실제 수정된 public 메서드"를
    // 강조하도록 변경 시드(공개 메서드) 합집합을 코어에 넘긴다.
    const changedMethods = new Set();
    selected.forEach(sha => {
      const c = commitBySha.get(sha);
      if (c) changedSeedIds(c).forEach(id => changedMethods.add(id));
    });
    FM.setDockChangedNodes(changedMethods);

    // 경계 투영(boundary projection) — 어플리케이션 내부 호출/변경 메서드는 접어 숨기고,
    // 변경이 영향을 준 endpoint(CONTROLLER)를 중심에 둔 채 s2s·화면(SCREEN)·외부/kafka 경계만 보여준다.
    //   음수 레벨 = 유입(화면/s2s 호출원), 0 = 변경·영향 엔드포인트, 양수 레벨 = 유출(외부 API/다른 서비스/kafka).
    const level = new Map();        // id -> 음수…0…양수 (표시 노드만)
    const edges = [];               // 경계 노드 사이의 축약 엣지
    const edgeSeen = new Set();
    let truncated = false;
    const addEdge = (source, target, e) => {
      const key = source + '→' + target;
      if (edgeSeen.has(key)) return;
      edgeSeen.add(key);
      edges.push({ source, target, kind: e.kind, relation: e.relation, mode: e.mode });
    };

    // anchor(표시 노드)에서 숨김(내부) 노드만 거쳐 닿는 경계 노드를 모은다 — 내부 체인 축약
    const collectBoundary = (anchor, edgeMap, sign) => {
      const found = [];
      const seen = new Set([anchor]);
      const stack = [anchor];
      while (stack.length) {
        const cur = stack.pop();
        for (const e of (edgeMap.get(cur) || [])) {
          const nb = sign > 0 ? e.target : e.source;
          if (!FM.nodeById.has(nb) || seen.has(nb)) continue;
          seen.add(nb);
          if (isBoundary(nb)) found.push({ bid: nb, edge: e });
          else stack.push(nb);   // 내부 노드 → 계속 접어 들어간다
        }
      }
      return found;
    };

    // 중심(level 0) = 변경(공개 메서드)이 영향 준 백엔드 엔드포인트(CONTROLLER)만.
    // 내부 변경 메서드는 카드로 그리지 않고 그 영향 endpoint 로 대표시킨다. 프론트 화면·외부호출은
    // 엔드포인트가 아니므로 중심에 두지 않고, 아래 경계 투영에서 유입(화면)/유출(infra)으로 배치한다.
    const centerSet = new Set();
    epIds.forEach(id => { if (FM.nodeById.has(id)) centerSet.add(id); });
    // 변경된 코드가 속한 프로젝트(서비스) — "수정된 endpoint" 는 이 프로젝트의 영향 엔드포인트다.
    const changedProjects = new Set();
    changedInGraph.forEach(id => { const n = FM.nodeById.get(id); if (n && n.project) changedProjects.add(n.project); });
    // 중심(앵커) = 수정된 endpoint = 직접 변경됐거나 변경 프로젝트에 속한 영향 엔드포인트만.
    // 다른 서비스에서 이 endpoint 를 호출하는(=영향 받은) 엔드포인트는 앵커로 두지 않는다 — 앵커로 두면
    // 1차인데도 그 호출 서비스가 부르는 또 다른 endpoint(2단계)까지 유출로 펼쳐진다. 그런 호출원은
    // 유입(피호출) 확장으로만 등장시킨다.
    let bases = [...centerSet].filter(id => {
      const n = FM.nodeById.get(id);
      return n && (changedSha.has(id) || (n.project && changedProjects.has(n.project)));
    });
    if (!bases.length) bases = [...centerSet];   // 수정 endpoint 를 못 가리면 전체 영향 엔드포인트로 폴백
    // 폴백: endpoint 로 롤업되지 않는 변경(엔드포인트 없는 내부 코드 등) → 변경 노드의 인접 경계를 중심으로
    if (!bases.length && changedInGraph.length) {
      const fb = new Set();
      changedInGraph.forEach(id => {
        collectBoundary(id, FM.outEdges, 1).forEach(({ bid }) => fb.add(bid));
        collectBoundary(id, FM.inEdges, -1).forEach(({ bid }) => fb.add(bid));
      });
      bases = [...fb];
    }
    bases.forEach(id => level.set(id, 0));

    const expand = (startIds, edgeMap, sign, maxHops) => {
      let frontier = startIds.slice();
      for (let d = 0; d < maxHops && frontier.length; d++) {
        const next = [];
        for (const anchor of frontier) {
          for (const { bid, edge } of collectBoundary(anchor, edgeMap, sign)) {
            if (!level.has(bid)) {
              if (level.size >= MAX_NODES) { truncated = true; continue; }
              level.set(bid, sign * (d + 1));
              next.push(bid);
            }
            if (sign > 0) addEdge(anchor, bid, edge); else addEdge(bid, anchor, edge);
          }
        }
        frontier = next;
      }
    };

    expand(bases, FM.outEdges, 1, hopDepth);   // 유출: 변경·영향 엔드포인트가 호출하는 외부 API/다른 서비스/kafka (현재 표시 단계까지)
    // 유입(피호출)은 "직접 수정된 노드"에만 연결한다 — 롤업 영향·유출(호출) 노드의 피호출은 클러터라 제외.
    // (직접 수정된 경계 노드가 하나도 없으면(순수 롤업 변경) 빈 유입 대신 전체 기준으로 폴백)
    const inboundSeeds = bases.filter(id => changedSha.has(id));
    expand(inboundSeeds.length ? inboundSeeds : bases, FM.inEdges, -1, hopDepth);   // 유입: 직접 수정 노드에 닿는 화면/s2s 호출원 (현재 표시 단계까지)

    // 상단 분석 바
    main.appendChild(buildBar(selected, changedSha, epIds, truncated, outOfGraph, opts.embedded));

    if (!bases.length) {
      // 코드 영향 없음(예: nginx.conf 변경) — 상세 패널·프로세스 독을 닫고 changedFiles만 보여줌
      FM.state.sel = null; FM.renderDetail();
      FM.setProcessDockEnabled(false);
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

    // 표시 단계(1/2/3차) 컨트롤 — 그래프가 있을 때만
    main.appendChild(buildDepthCtl(rerender));

    const gwrap = el('div', 'imp-gwrap');
    const graph = el('div', 'imp-graph imp-graph-svc');
    gwrap.appendChild(graph);
    main.appendChild(gwrap);
    let scrollRaf = 0;
    gwrap.addEventListener('scroll', () => {
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; FM.drawConnectors(); });
    });

    // 노드를 클릭해야만 상세 패널·프로세스 흐름이 열린다 (URL 오염 방지 위해 코어 setSel 대신 직접 제어).
    const setSelection = (id) => {
      FM.state.sel = (id && level.has(id)) ? id : null;
      FM.renderDetail();
      FM.setProcessDockEnabled(true);   // sel 있으면 독 표시, 없으면 숨김
      FM.applyHighlight();
    };
    // 배경(빈 공간) 클릭 → 선택 해제 (카드 클릭은 카드 핸들러가 처리)
    gwrap.addEventListener('click', (e) => {
      if (e.target.closest('.node-card')) return;
      if (FM.state.sel != null) setSelection(null);
    });

    // 카드 장식 — 변경(◆)/영향(◇)/경계 단계 배지를 레벨·레이어로 부여 (서비스 박스 안에서도 동일)
    const decorateCard = (card, id, lv) => {
      const node = FM.nodeById.get(id);
      const layer = node && node.layer;
      const shas = changedSha.get(id);
      if (lv === 0 && shas) {            // 직접 변경된 경계 노드(엔드포인트/화면 등)
        card.classList.add('imp-changed');
        card.prepend(el('div', 'imp-flag',
          `◆ ${FM.esc(shas[0])}${shas.length > 1 ? ` +${shas.length - 1}` : ''}`));
      } else if (lv === 0) {             // 변경이 롤업된 영향 대상(화면/엔드포인트)
        card.classList.add('imp-endpoint');
        card.prepend(el('div', 'imp-flag ' + (isScreenId(id) ? 'screen' : 'ep'), '◇ 영향 ' + targetNoun(id)));
      } else if (layer === 'SCREEN') {
        card.classList.add('imp-endpoint');   // 화면 뱃지는 makeCard 가 표시 (전체보기와 동일)
      } else if (layer === 'CONTROLLER') {
        card.classList.add('imp-endpoint');
        card.prepend(el('div', 'imp-flag ep', lv < 0 ? '↘ 유입 엔드포인트' : '↗ s2s 엔드포인트'));
      } else if (layer === 'EXTERNAL') {
        card.classList.add('imp-path');
        card.prepend(el('div', 'imp-flag ext', '🌐 외부 API'));
      } else if (layer === 'RESOURCE') {
        card.classList.add('imp-path');
        const rt = node && node.resourceType;
        const resFlag = rt === 'kafka-topic' ? '📨 Kafka'
          : rt === 'redis' ? '🧱 Redis'
          : rt === 'db-table' ? '🗄️ DB' : '🗄️ 인프라';
        card.prepend(el('div', 'imp-flag res', resFlag));
      } else {
        card.classList.add('imp-path');
      }
      // 유출/유입 단계에 떠오른 노드가 실제로 변경된 노드면(수정된 외부 클라이언트 등) ◆ 로 표시
      if (lv !== 0 && shas) {
        card.classList.add('imp-changed');
        card.prepend(el('div', 'imp-flag',
          `◆ ${FM.esc(shas[0])}${shas.length > 1 ? ` +${shas.length - 1}` : ''}`));
      }
      if (id === ep) card.classList.add('imp-ep-target');
    };

    // 엔드포인트 아래로 매달릴 "수정된 서비스/컴포넌트" 자식 — 엔드포인트에서 내부(비경계) 노드만 타고
    // 내려가며 닿는 변경 노드(changedSha)들. 다른 서비스/외부/인프라 경계는 넘지 않는다.
    const childChangedOf = (endpointId) => {
      const out = [];
      const seen = new Set([endpointId]);
      const stack = [endpointId];
      while (stack.length) {
        const cur = stack.pop();
        for (const e of (FM.outEdges.get(cur) || [])) {
          const t = e.target;
          if (seen.has(t) || !FM.nodeById.has(t)) continue;
          seen.add(t);
          if (isBoundary(t)) continue;            // 경계(다른 엔드포인트/외부/인프라)는 자식에 안 넣고 멈춤
          if (changedSha.has(t)) out.push(t);
          stack.push(t);                          // 내부 노드는 계속 따라 내려감
        }
      }
      return out;
    };
    const KID_MAX = 8;
    const appendChangedChildren = (card, endpointId) => {
      const kids = childChangedOf(endpointId);
      if (!kids.length) return;
      const wrap = el('div', 'imp-kids');
      kids.slice(0, KID_MAX).forEach(kid => {
        const kn = FM.nodeById.get(kid);
        const row = el('div', 'imp-kid',
          `<span class="imp-kid-layer">${FM.esc(kn.layer || 'CODE')}</span>` +
          `<span class="imp-kid-name">${FM.esc(kn.method || kid)}</span>` +
          `<span class="imp-kid-tag">수정</span>`);
        row.title = [kn.fqcn, kn.file ? kn.file + (kn.line ? ':' + kn.line : '') : null, kn.description]
          .filter(Boolean).join('\n');
        row.addEventListener('click', e => { e.stopPropagation(); if (FM.nodeById.has(kid)) FM.setSel(kid); });
        wrap.appendChild(row);
      });
      if (kids.length > KID_MAX) wrap.appendChild(el('div', 'imp-kid more', `+${kids.length - KID_MAX} 수정`));
      card.appendChild(wrap);
    };

    // 서비스(영역) 단위 재배치 — 노드를 소속 서비스 박스로 묶는다. 레벨은 박스 정렬(왼쪽=유입원,
    // 오른쪽=유출처)과 박스 안 카드 정렬에만 쓴다. 박스 헤더 칩은 커밋 레일과 동일한 색(projectHue).
    const areaOf = (id) => {
      const n = FM.nodeById.get(id);
      if (n && n.project) return n.project;
      if (n && n.layer === 'EXTERNAL') return '외부 API';
      if (n && n.layer === 'RESOURCE') return '인프라';
      return '(기타)';
    };
    const byArea = new Map();        // area → [id…]
    const areaLevel = new Map();     // area → 최소 레벨(박스 정렬용)
    level.forEach((lv, id) => {
      const a = areaOf(id);
      if (!byArea.has(a)) byArea.set(a, []);
      byArea.get(a).push(id);
      if (!areaLevel.has(a) || lv < areaLevel.get(a)) areaLevel.set(a, lv);
    });
    const areas = [...byArea.keys()].sort((x, y) =>
      (areaLevel.get(x) - areaLevel.get(y)) || x.localeCompare(y));

    areas.forEach(area => {
      // 박스 안에서는 유입(음수) → 변경·영향(0) → 유출(양수) 순으로 카드 정렬
      const ids = byArea.get(area).slice().sort((a, b) =>
        (level.get(a) - level.get(b)) ||
        String(FM.nodeById.get(a) && FM.nodeById.get(a).method || a)
          .localeCompare(FM.nodeById.get(b) && FM.nodeById.get(b).method || b));
      const hasChanged = ids.some(id => changedSha.has(id));
      const box = el('div', 'imp-svc-box' + (hasChanged ? ' has-changed' : ''));
      const h = projectHue(area);
      const head = el('div', 'imp-svc-head',
        `<span class="imp-proj" style="color:hsl(${h} 55% 38%);border-color:hsl(${h} 50% 55% / .45);` +
          `background:hsl(${h} 70% 55% / .12)" title="${FM.escAttr(area)}">${FM.esc(area)}</span>` +
        `<span class="imp-svc-count">${ids.length}</span>`);
      box.appendChild(head);
      const body = el('div', 'imp-svc-body');
      ids.forEach(id => {
        const card = FM.makeCard(id, { noCenter: true, onPick: setSelection });
        decorateCard(card, id, level.get(id));
        if (level.get(id) === 0) appendChangedChildren(card, id);   // 영향 엔드포인트에 수정 서비스/컴포넌트를 자식으로
        body.appendChild(card);
      });
      box.appendChild(body);
      graph.appendChild(box);
    });

    FM.setCanvasEdges(edges);

    // 커밋 (재)선택 시엔 닫힌 상태로 시작 — ep 딥링크일 때만 해당 엔드포인트를 자동 선택해 연다.
    // 단계(1/2/3차) 전환으로 다시 그릴 땐(_keepSel) 직전 선택을 유지(그 노드가 여전히 보이면).
    if (ep && level.has(ep)) {
      setSelection(ep);
      requestAnimationFrame(() => {
        const card = FM.cardEls && FM.cardEls.get && FM.cardEls.get(ep);
        if (card && card.scrollIntoView) card.scrollIntoView({ block: 'center', inline: 'nearest' });
      });
    } else if (opts._keepSel && prevSel && level.has(prevSel)) {
      setSelection(prevSel);
    } else {
      setSelection(null);
    }
  }

  // 표시 단계(1/2/3차) 선택 컨트롤 — 누르면 hopDepth 를 바꿔 그래프를 다시 그린다.
  function buildDepthCtl(rerender) {
    const box = el('div', 'imp-depthctl', '<span class="imp-depthctl-label">표시 단계</span>');
    for (let d = 1; d <= MAX_HOP; d++) {
      const btn = el('button', 'imp-depthbtn' + (d === hopDepth ? ' on' : ''), d + '차');
      btn.title = `직접 변경 노드 기준 ${d}차 연결까지 표시`;
      btn.onclick = () => { if (hopDepth !== d) { hopDepth = d; rerender(); } };
      box.appendChild(btn);
    }
    return box;
  }

  // embedded=true 면 배포 영향도 하단 임베드용 — 커밋 영향도 URL 을 바꾸는 컨트롤(칩 ✕ · 전체 해제)을 숨긴다.
  function buildBar(selected, changedSha, epIds, truncated, outOfGraph, embedded) {
    const bar = el('div', 'imp-bar');

    selected.forEach(sha => {
      const c = commitBySha.get(sha);
      const chip = el('span', 'imp-barchip',
        `<span class="imp-sha">◆ ${FM.esc(sha)}</span>` +
        `<span class="imp-barsubj" title="${FM.escAttr(c ? c.subject : '')}">${FM.esc(c ? c.subject : '')}</span>` +
        (embedded ? '' : `<button class="imp-x" title="이 커밋 제거">✕</button>`));
      if (!embedded) chip.querySelector('.imp-x').onclick = () => pushSel(selected.filter(s => s !== sha), '');
      bar.appendChild(chip);
    });

    bar.appendChild(el('span', 'imp-cc', `변경 ${changedSha.size}`));
    bar.appendChild(el('span', 'imp-cc', `영향 ${nounOf(epIds)} ${epIds.size}`));
    if (truncated) bar.appendChild(el('span', 'imp-cc warn', `(일부만 표시 — ${MAX_NODES}노드 상한)`));

    // 변경 노드는 endpoint 로 롤업해 그래프에서 카드로 그리지 않으므로, 무엇이 바뀌었는지는 접이식 목록으로 유지
    if (changedSha.size) {
      const det = el('details', 'imp-ext');
      det.innerHTML = `<summary>변경 코드 ${changedSha.size}건</summary>`;
      const body = el('div', 'imp-ext-body');
      changedSha.forEach((shas, id) => {
        const n = FM.nodeById.get(id);
        const label = n && (n.layer === 'CONTROLLER' && n.endpoint
          ? `${n.httpMethod || ''} ${n.endpoint}`.trim() : (n.method || id));
        const row = el('div', 'imp-ext-item', `${shaChip(shas[0])} <code>${FM.esc(label)}</code>`);
        if (FM.nodeById.has(id)) { row.classList.add('clickable'); row.onclick = () => FM.setSel(id); }
        body.appendChild(row);
      });
      det.appendChild(body);
      bar.appendChild(det);
    }

    if (outOfGraph.length) {
      const det = el('details', 'imp-ext');
      det.innerHTML = `<summary>그래프 외 변경 ${outOfGraph.length}건</summary>`;
      const body = el('div', 'imp-ext-body');
      outOfGraph.forEach(({ id, sha }) =>
        body.appendChild(el('div', 'imp-ext-item', `${shaChip(sha)} <code>${FM.esc(id)}</code>`)));
      det.appendChild(body);
      bar.appendChild(det);
    }

    if (!embedded) {
      const clear = el('button', 'btn', '전체 해제');
      clear.onclick = () => pushSel([], '');
      bar.appendChild(clear);
    }
    return bar;
  }

  /* ───────── 상세 패널 확장: CONTROLLER → 영향 커밋 ───────── */

  FM.registerDetailExtension((node, panelEl) => {
    // 백엔드 엔드포인트(CONTROLLER) + 프론트 화면(SCREEN) 둘 다 "영향 커밋" 섹션을 단다.
    if (!node || (node.layer !== 'CONTROLLER' && node.layer !== 'SCREEN')) return;

    const append = d => {
      if (!d || !panelEl.isConnected) return;
      const entry = getEndpointImpact().find(e => e.id === node.id);
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

  /* ───────── 공개 API: 다른 기능 뷰(배포 영향도)에서 커밋 영향도 콘텐츠 재사용 ─────────
   * 배포 영향도(deploy.js)가 PR 을 선택하면 커밋 영향도로 이동하지 않고, 이 API 로
   * 동일한 "분석 바 + 경계 투영 그래프"를 자기 하단 컨테이너에 임베드한다. */
  FM.impact = {
    // impact 데이터 로드(+commitBySha 채움). null=데이터 없음.
    ensure: ensureData,
    // PR 번호 → 로드된 데이터에 존재하면 커밋 키('PR<번호>'), 없으면 null.
    prKey(number) { const k = 'PR' + number; return commitBySha.has(k) ? k : null; },
    // [container] 에 주어진 커밋/PR(shas)의 영향도 콘텐츠를 임베드 렌더. 커밋 영향도 URL 은 건드리지 않는다.
    async renderInto(container, shas, options) {
      options = options || {};
      await ensureData();
      if (!data || !Array.isArray(data.commits)) { container.innerHTML = ''; return false; }
      const valid = (shas || []).filter(s => commitBySha.has(s));
      if (!valid.length) { container.innerHTML = ''; return false; }
      container.innerHTML = '<div class="imp-loading">상세 불러오는 중…<div class="imp-skel"></div><div class="imp-skel"></div></div>';
      await ensureShards(valid);
      container.innerHTML = '';
      renderGraph(container, valid, options.ep || '', { embedded: true });
      requestAnimationFrame(() => { FM.drawConnectors(); FM.applyHighlight(); });
      return true;
    },
  };
})();
