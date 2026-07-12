// ─────────────────────────────────────────────────────────────────────────
// Chains dashboard — Networks (default landing: KPIs + chains + L2 scaling),
// Relationships (lazy-loaded 3D graph), Incidents and Providers (live
// operator/RPC-provider status, last 30 days).
// Data: chains-api /summary (slim bulk, ETag + localStorage SWR; falls back
// to /export then the checked-in snapshot), per-chain detail endpoints on
// drawer open, and chains-status-news (WebSocket /ws).
// ─────────────────────────────────────────────────────────────────────────

const SAME_ORIGIN_API =
    location.port === '3000' || location.hostname === 'chains-api.johnaverse.cc';
const API_BASE = SAME_ORIGIN_API ? '' : 'https://chains-api.johnaverse.cc';
const STATUS_NEWS_BASE = 'https://chains-status-news.johnaverse.cc';
const FORUM_NEWS_BASE = 'https://chains-forum-news.johnaverse.cc';

const COLORS = {
    Mainnet: '#10b981', L2: '#8b5cf6', Testnet: '#f59e0b', Beacon: '#ec4899', Default: '#6b7280'
};
const ALL_SOURCES = ['chains', 'chainlist', 'theGraph', 'slip44', 'l2beat'];

const state = {
    chains: [], byId: new Map(), rel: new Map(),
    l2beat: new Map(), l2beatProjects: [], l2beatMeta: null,
    statusPagesByChain: new Map(),
    lastUpdated: null
};

// graph state
let graphData = { nodes: [], links: [] };
let filteredData = { nodes: [], links: [] };
let currentFilter = 'all';
let enabledSources = new Set(ALL_SOURCES);
let myGraph = null;
let graphBuilt = false;
let graphDirty = true;      // data changed since the graph was last (re)built
let graphLibPromise = null; // in-flight lazy load of 3d-force-graph.min.js

// ─── DOM helper ───
function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (v !== null && v !== undefined) node.setAttribute(k, v);
    }
    for (const c of [].concat(children)) {
        if (c == null) continue;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
}

function classify(c) {
    if (c.tags?.includes('Beacon')) return 'Beacon';
    if (c.tags?.includes('L2')) return 'L2';
    if (c.tags?.includes('Testnet')) return 'Testnet';
    return 'Mainnet';
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function fmtUsd(n) {
    if (n == null || !Number.isFinite(n)) return '—';
    if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
    if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
    return `$${n.toFixed(0)}`;
}
function fmtDuration(ms) {
    if (!ms || ms < 0) return null;
    const m = Math.round(ms / 60000);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${m % 60}m`;
    return `${Math.floor(h / 24)}d ${h % 24}h`;
}
function safeHost(url) { try { const u = new URL(url); return (u.protocol === 'http:' || u.protocol === 'https:') ? u.host : null; } catch { return null; } }
function iconColorFor(chainId) { const c = state.byId.get(chainId); return c ? COLORS[classify(c)] : COLORS.Default; }
function networkIcon(label, color, cls = 'net-icon') {
    const n = el('span', { class: cls, text: (label || '?').charAt(0).toUpperCase() });
    n.style.background = `linear-gradient(135deg, ${color}, ${color}44)`;
    return n;
}

async function api(path, { timeoutMs = 25000 } = {}) {
    // fetch() has no built-in timeout — a stalled response (e.g. the multi-MB
    // /export over a flaky connection) would otherwise hang forever and the
    // page would never fall back or surface an error. Abort so callers can.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(`${API_BASE}${path}`, { headers: { accept: 'application/json' }, signal: ctrl.signal });
        if (!res.ok) throw new Error(`${path} → ${res.status}`);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

// POST helper for the assistant. Unlike api(), non-2xx responses still carry a
// useful JSON body ({error}) — return status + body so callers can branch.
async function apiPost(path, body, { timeoutMs = 70000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(`${API_BASE}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(body),
            signal: ctrl.signal
        });
        let data = null;
        try { data = await res.json(); } catch { /* non-JSON error body */ }
        return { status: res.status, ok: res.ok, data };
    } finally {
        clearTimeout(timer);
    }
}

// ─────────────────────────────── bootstrap ───────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    initTabs();
    initSearch();
    initGraphControls();
    initDrawer();
    initAssistant();
    initIncidentControls();
    initChainsTableHeader();
    initAppbarHeight();     // keep --appbar-h in sync with the real bar height
    document.getElementById('loadRetryBtn')?.addEventListener('click', () => loadBulk());
    applyUrlState();        // restore view + ?q= immediately (before data loads)
    // Start the live incidents feed immediately — it must NOT wait on the
    // bulk load or it appears stuck.
    connectStatusFeed();
    loadStatsLine();
    loadBulk();
    window.addEventListener('popstate', applyUrlState);
});

let stats = null;
async function loadStatsLine() {
    try {
        stats = await api('/stats');
        document.getElementById('statsLine').textContent =
            `${stats.totalChains} chains · ${stats.totalMainnets} mainnets · ${stats.totalL2s} L2s · ${stats.totalTestnets} testnets`;
        renderSummaryCards();
    } catch { /* noop */ }
}

// ─── bulk load: /summary with ETag + localStorage stale-while-revalidate ───
// A cached copy renders instantly on repeat visits; the network trip then
// revalidates (304 = free) or refreshes in the background.
const SUMMARY_LS_KEY = 'chains:summary:v1';
const SUMMARY_TTL_MS = 24 * 60 * 60 * 1000; // ignore copies older than a day

function readCachedSummary() {
    try {
        const raw = localStorage.getItem(SUMMARY_LS_KEY);
        if (!raw) return null;
        const entry = JSON.parse(raw);
        if (!entry?.payload?.chains || Date.now() - (entry.savedAt || 0) > SUMMARY_TTL_MS) return null;
        return entry;
    } catch { return null; }
}
function writeCachedSummary(payload, etag) {
    try { localStorage.setItem(SUMMARY_LS_KEY, JSON.stringify({ savedAt: Date.now(), etag: etag || null, payload })); }
    catch { /* quota/private mode — cache is best-effort */ }
}

async function loadBulk() {
    hideLoadError();
    const cached = readCachedSummary();
    if (cached) applyBulk(cached.payload);

    // 1) /summary (slim, ETag-aware) — 2 attempts for transient tunnel blips.
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const headers = { accept: 'application/json' };
            if (cached?.etag) headers['if-none-match'] = cached.etag;
            const res = await fetch(`${API_BASE}/summary`, { headers, signal: AbortSignal.timeout(25000) });
            if (res.status === 304) { writeCachedSummary(cached.payload, cached.etag); return; } // cache is current
            if (!res.ok) throw new Error(`${res.status}`);
            const payload = await res.json();
            writeCachedSummary(payload, res.headers.get('etag'));
            applyBulk(payload);
            return;
        } catch { if (attempt === 0) await new Promise(r => setTimeout(r, 1200)); }
    }
    // 2) legacy /export (older API deployments), 3) checked-in slim snapshot.
    try { applyBulk(await api('/export')); return; } catch { /* next */ }
    try { applyBulk(await (await fetch('summary.json')).json()); return; } catch { /* fall through */ }
    if (!state.chains.length) showLoadError();
}

// Accepts both shapes: /summary ({chains, l2beat}) and /export ({data:{indexed:{all}}}).
let statusPagesLoaded = false;
function applyBulk(payload) {
    const data = payload.data ?? payload;
    state.chains = data.chains ?? data.indexed?.all ?? [];
    state.lastUpdated = data.lastUpdated ?? null;
    state.byId = new Map(state.chains.map(c => [c.chainId, c]));
    state.l2beatMeta = data.l2beat ? { source: data.l2beat.source, count: (data.l2beat.projects || []).length } : null;
    state.l2beatProjects = data.l2beat?.projects ?? [];
    state.l2beat = new Map();
    for (const p of state.l2beatProjects) if (p.chainId != null) state.l2beat.set(p.chainId, p);
    state.rel = new Map();

    buildRelations();
    graphDirty = true;
    if (activeView === 'graph') ensureGraphView();
    renderSummaryCards();   // total TVS needs the L2BEAT projects just loaded
    renderScalingChart();
    renderChainsView();
    if (!document.getElementById('statsLine').textContent.includes('chains')) {
        document.getElementById('statsLine').textContent = `${state.chains.length} chains loaded`;
    }
    if (!statusPagesLoaded) { statusPagesLoaded = true; loadStatusPages(); } // drawer status-page links
    applyUrlState();        // deep-link ?chain=
}

function showLoadError() {
    const b = document.getElementById('loadErrorBanner');
    if (b) b.classList.remove('hidden');
    const o = document.getElementById('loadingOverlay');
    if (o) {
        o.querySelector('.spinner').style.display = 'none';
        o.querySelector('p').textContent = 'Failed to load data.';
        o.querySelector('.loading-sub').textContent = 'Check your connection or that the API is reachable.';
    }
}
function hideLoadError() { document.getElementById('loadErrorBanner')?.classList.add('hidden'); }

// ─── relations ───
function relEntry(id) {
    if (!state.rel.has(id)) state.rel.set(id, { l1Parent: null, mainnet: null, l2Children: [], testnetChildren: [] });
    return state.rel.get(id);
}
function buildRelations() {
    for (const c of state.chains) {
        for (const r of c.relations ?? []) {
            if (r.chainId == null) continue;
            if (r.kind === 'l2Of') { relEntry(c.chainId).l1Parent = r.chainId; relEntry(r.chainId).l2Children.push(c.chainId); }
            else if (r.kind === 'parentOf') { relEntry(r.chainId).l1Parent = c.chainId; relEntry(c.chainId).l2Children.push(r.chainId); }
            else if (r.kind === 'testnetOf') { relEntry(c.chainId).mainnet = r.chainId; relEntry(r.chainId).testnetChildren.push(c.chainId); }
            else if (r.kind === 'mainnetOf') { relEntry(r.chainId).mainnet = c.chainId; relEntry(c.chainId).testnetChildren.push(r.chainId); }
        }
    }
    for (const e of state.rel.values()) { e.l2Children = [...new Set(e.l2Children)]; e.testnetChildren = [...new Set(e.testnetChildren)]; }
}

// ─── keep --appbar-h equal to the real (wrapping) app-bar height ───
// The bar is position:fixed; content uses padding-top:var(--appbar-h). A fixed
// guess overlaps on mobile when the bar wraps to extra rows (long stats line,
// scrolled tabs). Measuring it guarantees content always clears the bar.
function initAppbarHeight() {
    const bar = document.getElementById('appbar');
    if (!bar) return;
    const sync = () => document.documentElement.style.setProperty('--appbar-h', `${bar.offsetHeight}px`);
    sync();
    window.addEventListener('resize', sync);
    if ('ResizeObserver' in window) new ResizeObserver(sync).observe(bar);
    // Treemap tiles are absolutely positioned in px — re-fit on width change.
    let rt;
    window.addEventListener('resize', () => {
        if (activeView !== 'forum' || !forum.loaded) return;
        clearTimeout(rt); rt = setTimeout(renderForumTreemap, 150);
    });
}

// ─────────────────────────────── tabs ───────────────────────────────
function initTabs() {
    const tabs = [...document.querySelectorAll('#tabs .tab')];
    tabs.forEach(btn => btn.addEventListener('click', () => switchView(btn.dataset.view)));
    // Arrow keys cycle the tab group (ARIA tabs pattern).
    document.getElementById('tabs')?.addEventListener('keydown', e => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const i = tabs.findIndex(t => t.dataset.view === activeView);
        const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
        next.focus(); switchView(next.dataset.view);
    });
}
// View / search / selected-chain are all reflected in the URL so each tab is a
// separate, shareable, reloadable page (e.g. ?view=incidents&q=base).
// Networks is the default landing view: info-dense and cheap to render —
// the 3D graph (1.2 MB lib + physics warmup) only loads when visited.
const VIEWS = ['networks', 'graph', 'incidents', 'providers', 'forum'];
const DEFAULT_VIEW = 'networks';
let activeView = DEFAULT_VIEW;
let searchQuery = '';
let openChainId = null;

function switchView(view, opts = {}) {
    if (!VIEWS.includes(view)) view = DEFAULT_VIEW;
    activeView = view;
    document.querySelectorAll('#tabs .tab').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(`view-${view}`).classList.add('active');
    document.body.classList.toggle('graph-active', view === 'graph');
    if (view === 'graph') ensureGraphView();
    if (view === 'forum') ensureForumView();
    updateSearchPlaceholder();
    applySearch();
    if (!opts.fromUrl) updateUrl({ push: true });
}

function updateSearchPlaceholder() {
    const input = document.getElementById('searchInput');
    if (input) input.placeholder = activeView === 'networks' ? 'Filter networks — id or name…'
        : activeView === 'incidents' ? 'Filter incidents — network or title…'
        : activeView === 'providers' ? 'Filter provider incidents — provider, chain or title…'
        : activeView === 'forum' ? 'Filter forum posts — network, forum or title…'
        : 'Find a network — id or name…';
}

// Apply the current ?q= search to whichever page is active.
function applySearch() {
    if (activeView === 'networks') { chainShown = CHAIN_PAGE; renderChainsView(); }
    else if (activeView === 'incidents') renderIncidentList();
    else if (activeView === 'providers') renderProviderList();
    else if (activeView === 'forum') { renderForumTreemap(); renderForumList(); }
}

function updateUrl({ push = false } = {}) {
    const u = new URL(location.href);
    const set = (k, v) => { if (v == null || v === '') u.searchParams.delete(k); else u.searchParams.set(k, v); };
    set('view', activeView === DEFAULT_VIEW ? null : activeView); // default view keeps the URL clean
    set('q', searchQuery || null);
    set('chain', openChainId);
    history[push ? 'pushState' : 'replaceState'](null, '', u);
}

// Restore view + query + open-chain from the URL (on load and on back/forward).
function applyUrlState() {
    const params = new URLSearchParams(location.search);
    const q = params.get('q') || '';
    searchQuery = q.trim().toLowerCase();
    const input = document.getElementById('searchInput');
    if (input && input.value !== q) input.value = q;
    switchView(params.get('view') || DEFAULT_VIEW, { fromUrl: true });

    const chain = params.get('chain');
    if (chain && state.byId.has(Number(chain))) openChainDetail(Number(chain), { fromUrl: true });
    else closeDrawer({ fromUrl: true });
}

// ─────────────────────────────── search (global) ───────────────────────────────
// One predicate for every chain search surface (dropdown, networks table):
// id, name, shortName, and the registry aliases /summary ships for renamed
// chains — typing "optimism" must find OP Mainnet (10), "xdai" → Gnosis.
function chainMatchesQuery(c, q) {
    return String(c.chainId).includes(q)
        || c.name?.toLowerCase().includes(q)
        || c.shortName?.toLowerCase().includes(q)
        || (c.aliases || []).some(a => a.includes(q));
}

function initSearch() {
    const input = document.getElementById('searchInput');
    const dd = document.getElementById('searchDropdown');
    let activeIdx = -1;

    // A jump-to-network autocomplete on every view (select → open detail). On
    // Networks/Incidents the same query also filters the page.
    const renderDropdown = debounce(q => {
        if (!q) { dd.classList.add('hidden'); return; }
        const matches = state.chains.filter(c => chainMatchesQuery(c, q)).sort((a, b) => {
            // Dead chains sink below living ones, then a name OR alias
            // starting with the query outranks mid-string hits — "optimism"
            // puts OP Mainnet (alias match) on top, Optimism Kovan last.
            const ad = a.status === 'deprecated', bd = b.status === 'deprecated';
            if (ad !== bd) return ad ? 1 : -1;
            const hit = c => (c.name || '').toLowerCase().startsWith(q) || (c.aliases || []).some(t => t.startsWith(q));
            const as = hit(a), bs = hit(b);
            if (as !== bs) return as ? -1 : 1;
            return (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
        }).slice(0, 40);
        dd.textContent = ''; activeIdx = -1;
        if (!matches.length) dd.appendChild(el('div', { class: 'dropdown-empty', text: 'No networks found.' }));
        for (const c of matches) {
            dd.appendChild(el('div', { class: 'dropdown-item', 'data-id': c.chainId, onclick: () => pick(c.chainId) }, [
                networkIcon(c.name, COLORS[classify(c)], 'dropdown-icon'),
                el('div', { class: 'dropdown-info' }, [
                    el('span', { class: 'dropdown-name', text: c.name || `Chain ${c.chainId}` }),
                    el('div', { class: 'dropdown-meta', text: `ID: ${c.chainId} · ${(c.tags || []).join(', ') || classify(c)}${c.status === 'deprecated' ? ' · deprecated' : ''}` })
                ])
            ]));
        }
        dd.classList.remove('hidden');
    }, 140);

    // Filtering the page re-renders the whole table/list — debounce it so
    // fast typing doesn't rebuild 2.5k rows per keystroke.
    const debouncedApplySearch = debounce(applySearch, 150);
    function onInput(raw) {
        searchQuery = raw.trim().toLowerCase();
        updateUrl();           // ?q= reflects the search (shareable / reloadable)
        debouncedApplySearch();
        renderDropdown(searchQuery);
    }
    function pick(id) { dd.classList.add('hidden'); openChainDetail(id); if (activeView === 'graph') focusNodeById(id); }
    globalThis.pickChain = pick;

    input.addEventListener('input', e => onInput(e.target.value));
    input.addEventListener('keydown', e => {
        const items = dd.querySelectorAll('.dropdown-item');
        if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, items.length - 1); mark(items); }
        else if (e.key === 'ArrowUp' && items.length) { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); mark(items); }
        else if (e.key === 'Enter') { e.preventDefault(); const t = items[activeIdx] || items[0]; if (t) pick(Number(t.dataset.id)); }
        else if (e.key === 'Escape') { dd.classList.add('hidden'); input.blur(); }
    });
    function mark(items) { items.forEach((it, i) => it.classList.toggle('active', i === activeIdx)); items[activeIdx]?.scrollIntoView({ block: 'nearest' }); }
    document.addEventListener('click', e => { if (!e.target.closest('.search-box')) dd.classList.add('hidden'); });
    document.addEventListener('keydown', e => {
        // "/" focuses global search — unless the user is typing somewhere else
        // (e.g. the assistant textarea).
        const tag = document.activeElement?.tagName;
        if (e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA') { e.preventDefault(); input.focus(); }
    });
}

// ─────────────────────────────── graph ───────────────────────────────
// The 1.2 MB 3d-force-graph library is NOT in index.html — it's injected on
// the first visit to the Relationships tab so the default Networks landing
// stays light.
function ensureGraphLib() {
    if (globalThis.ForceGraph3D) return Promise.resolve();
    if (!graphLibPromise) {
        graphLibPromise = new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = '3d-force-graph.min.js';
            s.onload = resolve;
            s.onerror = () => { graphLibPromise = null; reject(new Error('graph lib failed to load')); };
            document.head.appendChild(s);
        });
    }
    return graphLibPromise;
}
async function ensureGraphView() {
    if (myGraph) setTimeout(() => myGraph.width(window.innerWidth).height(window.innerHeight), 0);
    if (!state.chains.length) return; // data still loading; applyBulk() re-enters
    try { await ensureGraphLib(); } catch { showLoadError(); return; }
    if (activeView !== 'graph') return; // user tabbed away while the lib loaded
    if (graphDirty) { buildGraph(); applyGraphFilter(); graphDirty = false; }
}

function initGraphControls() {
    document.querySelectorAll('.filter-btn').forEach(btn => btn.addEventListener('click', e => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        e.currentTarget.classList.add('active');
        currentFilter = e.currentTarget.dataset.filter; applyGraphFilter();
    }));
    const toggle = document.getElementById('sourcesToggle');
    const ddrop = document.getElementById('sourcesDropdown');
    toggle?.addEventListener('click', () => ddrop.classList.toggle('hidden'));
    document.addEventListener('click', e => { if (!e.target.closest('#sourcesPanel')) ddrop?.classList.add('hidden'); });
    ddrop?.querySelectorAll('input[data-source]').forEach(cb => cb.addEventListener('change', () => {
        cb.checked ? enabledSources.add(cb.dataset.source) : enabledSources.delete(cb.dataset.source);
        buildGraph(); applyGraphFilter();
    }));
}
function visibleChains() {
    if (enabledSources.size === ALL_SOURCES.length) return state.chains;
    return state.chains.filter(c => c.sources?.some(s => enabledSources.has(s)));
}
function buildGraph() {
    // Lib not in yet (lazy load in flight, or a source toggle raced it):
    // mark dirty and let ensureGraphView() rebuild once it lands.
    if (!globalThis.ForceGraph3D) { graphDirty = true; return; }
    const chains = visibleChains();
    const ids = new Set(chains.map(c => c.chainId));
    const nodes = []; const nodeMap = new Map();
    for (const c of chains) {
        const type = classify(c);
        let name = c.name || `Chain ${c.chainId}`;
        if (type === 'Testnet' && !name.toLowerCase().includes('testnet')) name += ' Testnet';
        const val = type === 'Mainnet' ? (c.chainId === 1 ? 8 : 3) : type === 'L2' ? 1.8 : type === 'Beacon' ? 1.5 : 1;
        const node = { id: c.chainId, name, val, color: COLORS[type], type };
        nodes.push(node); nodeMap.set(c.chainId, node);
    }
    const links = [];
    for (const c of chains) {
        const e = state.rel.get(c.chainId); if (!e) continue;
        if (e.l1Parent != null && ids.has(e.l1Parent)) links.push({ source: c.chainId, target: e.l1Parent, kind: 'l2Of' });
        if (e.mainnet != null && ids.has(e.mainnet)) links.push({ source: c.chainId, target: e.mainnet, kind: 'testnetOf' });
    }
    graphData = { nodes, links };
    filteredData = { nodes: [...nodes], links: [...links] };
    if (!graphBuilt) { renderGraph(); graphBuilt = true; document.getElementById('loadingOverlay')?.classList.add('hidden'); }
}
function linksFor(idSet, exclude) {
    return graphData.links.filter(l => {
        const s = l.source.id ?? l.source, t = l.target.id ?? l.target;
        return idSet.has(s) && idSet.has(t) && (!exclude || l.kind !== exclude);
    });
}
function applyGraphFilter() {
    if (currentFilter === 'all') filteredData = { nodes: [...graphData.nodes], links: [...graphData.links] };
    else {
        const set = new Set();
        for (const n of graphData.nodes) if (n.type === currentFilter) {
            set.add(n.id);
            const e = state.rel.get(n.id);
            if (e?.l1Parent != null) set.add(e.l1Parent);
            if (e?.mainnet != null) set.add(e.mainnet);
        }
        filteredData = { nodes: graphData.nodes.filter(n => set.has(n.id)), links: linksFor(set) };
    }
    if (myGraph) myGraph.graphData(filteredData);
}
function renderGraph() {
    myGraph = ForceGraph3D()(document.getElementById('3d-graph'))
        .graphData(filteredData)
        .nodeLabel('name').nodeColor('color').nodeVal('val').nodeResolution(12).nodeOpacity(0.9)
        .linkColor(l => l.kind === 'l2Of' ? 'rgba(139,92,246,0.4)' : l.kind === 'testnetOf' ? 'rgba(245,158,11,0.4)' : 'rgba(255,255,255,0.1)')
        .linkWidth(0.8)
        .linkDirectionalParticles(l => (l.kind === 'l2Of' || l.kind === 'testnetOf') ? 2 : 0)
        .linkDirectionalParticleSpeed(0.004).linkDirectionalParticleWidth(1.5)
        .linkDirectionalParticleColor(l => l.kind === 'l2Of' ? 'rgba(139,92,246,0.7)' : 'rgba(245,158,11,0.7)')
        .backgroundColor('#060608').warmupTicks(80).cooldownTicks(60)
        .onNodeClick(n => { focusNode(n); openChainDetail(n.id); });
    window.addEventListener('resize', () => myGraph && myGraph.width(window.innerWidth).height(window.innerHeight));
}
function focusNode(node) {
    if (!myGraph || node.x == null) return;
    const r = 1 + 150 / Math.hypot(node.x, node.y, node.z);
    myGraph.cameraPosition({ x: node.x * r, y: node.y * r, z: node.z * r }, node, 1200);
}
function focusNodeById(id) { const n = filteredData.nodes.find(x => x.id === id) || graphData.nodes.find(x => x.id === id); if (n) focusNode(n); }

// ─────────────────────────────── summary metric strip ───────────────────────────────
function totalTvs() { return state.l2beatProjects.reduce((s, p) => s + (p.tvs || 0), 0); }
function renderSummaryCards() {
    const wrap = document.getElementById('summaryCards'); if (!wrap) return;
    const s = stats || {};
    const num = v => (v != null ? Number(v).toLocaleString() : '—');
    const tvs = totalTvs();
    const rpcPct = s.rpc ? Number(s.rpc.healthPercent) : null;
    const cards = [
        { label: 'Networks', value: num(s.totalChains ?? (state.chains.length || null)) },
        { label: 'Mainnets', value: num(s.totalMainnets) },
        { label: 'L2s', value: num(s.totalL2s) },
        { label: 'Testnets', value: num(s.totalTestnets) },
        {
            label: 'RPC health', value: rpcPct != null ? `${rpcPct}%` : '—',
            sub: s.rpc ? `${num(s.rpc.working)} / ${num(s.rpc.tested)} endpoints` : '',
            tone: rpcPct == null ? '' : rpcPct >= 90 ? 'good' : rpcPct >= 70 ? 'warn' : 'bad',
            bar: rpcPct
        },
        { label: 'Total TVS', value: tvs ? fmtUsd(tvs) : '—', sub: state.l2beatProjects.length ? `${state.l2beatProjects.length} L2BEAT projects` : '' }
    ];
    wrap.textContent = '';
    for (const c of cards) {
        const card = el('div', { class: `stat-card ${c.tone || ''}` }, [
            el('div', { class: 'stat-value', text: c.value }),
            el('div', { class: 'stat-label', text: c.label }),
            c.sub ? el('div', { class: 'stat-sub', text: c.sub }) : null
        ]);
        if (c.bar != null) {
            const track = el('div', { class: 'stat-bar' }, [el('div', { class: 'stat-bar-fill' })]);
            track.firstChild.style.width = `${Math.max(0, Math.min(100, c.bar))}%`;
            card.appendChild(track);
        }
        wrap.appendChild(card);
    }
}

// ─────────────────────────────── Chains table ───────────────────────────────
let chainSort = { key: 'chainId', dir: 1 };
let chainTagFilter = 'all';
const CHAIN_PAGE = 200;
let chainShown = CHAIN_PAGE;

function initChainsTableHeader() {
    document.querySelectorAll('#chainsTable thead th[data-sort]').forEach(th => th.addEventListener('click', () => {
        const k = th.dataset.sort; chainSort.dir = chainSort.key === k ? -chainSort.dir : 1; chainSort.key = k; renderChainsView();
    }));
    document.querySelectorAll('#chainTagChips .chip').forEach(chip => chip.addEventListener('click', () => {
        document.querySelectorAll('#chainTagChips .chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active'); chainTagFilter = chip.dataset.tag; chainShown = CHAIN_PAGE; renderChainsView();
    }));
}
// Type = the environment (Mainnet/Testnet). L2 / Beacon / ZK / Validium /
// Optimium are orthogonal tags — a chain can be a mainnet-L2 or a testnet-L2.
function networkType(c) { return c.tags?.includes('Testnet') ? 'Testnet' : 'Mainnet'; }
function extraTags(c) { return (c.tags || []).filter(t => t !== 'Testnet'); }

function chainRowData(c) {
    // /summary precomputes rpcCount; the /export fallback still ships raw URLs.
    const rpcCount = c.rpcCount ?? (c.rpc || []).filter(u => { const url = typeof u === 'string' ? u : u?.url; return url && url.startsWith('http') && !url.includes('${'); }).length;
    const l2b = state.l2beat.get(c.chainId);
    return {
        chainId: c.chainId, name: c.name || `Chain ${c.chainId}`,
        type: networkType(c), tags: extraTags(c), stage: l2b?.stage || '',
        rpcs: rpcCount, tvs: l2b?.tvs ?? null, status: c.status || ''
    };
}
function renderChainsView() {
    const body = document.getElementById('chainsTableBody'); if (!body) return;
    const q = searchQuery;
    let rows = state.chains.filter(c => {
        if (chainTagFilter !== 'all') {
            if (chainTagFilter === 'Mainnet') { if (networkType(c) !== 'Mainnet') return false; }      // env: not a testnet (incl. mainnet-L2s)
            else if (chainTagFilter === 'Testnet') { if (!c.tags?.includes('Testnet')) return false; }  // env: testnet (incl. testnet-L2s)
            else if (!c.tags?.includes(chainTagFilter)) return false;                                   // tag membership: L2 / Beacon / ZK …
        }
        if (q && !chainMatchesQuery(c, q)) return false;
        return true;
    }).map(chainRowData);

    const { key, dir } = chainSort;
    rows.sort((a, b) => {
        let av = a[key], bv = b[key];
        if (key === 'tvs') { av = av ?? -1; bv = bv ?? -1; }
        if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
        return String(av).localeCompare(String(bv)) * dir;
    });

    document.getElementById('chainsCount').textContent = `${rows.length.toLocaleString()} shown`;
    body.textContent = '';
    for (const r of rows.slice(0, chainShown)) {
        body.appendChild(el('tr', { 'data-id': r.chainId, onclick: () => openChainDetail(r.chainId) }, [
            el('td', { class: 'num mono', text: String(r.chainId) }),
            el('td', {}, [el('span', { class: 'cell-name', text: r.name })]),
            el('td', {}, [
                el('span', { class: `tag tag-${r.type.toLowerCase()}`, text: r.type }),
                ...r.tags.map(t => el('span', { class: `tag tag-${t.toLowerCase()}`, text: t }))
            ]),
            el('td', {}, [r.stage ? el('span', { class: 'pill pill-stage', text: r.stage }) : el('span', { class: 'muted', text: '—' })]),
            el('td', { class: 'num', text: r.tvs != null ? fmtUsd(r.tvs) : '—' }),
            el('td', { class: 'num', text: r.rpcs ? String(r.rpcs) : '—' }),
            el('td', {}, [statusBadge(r.status)])
        ]));
    }
    const more = document.getElementById('chainsTableMore'); more.textContent = '';
    if (rows.length > chainShown) more.appendChild(el('button', { class: 'load-more', text: `Show more (${(rows.length - chainShown).toLocaleString()} remaining)`, onclick: () => { chainShown += CHAIN_PAGE * 2; renderChainsView(); } }));
}
function statusBadge(status) {
    if (!status) return el('span', { class: 'muted', text: '—' });
    return el('span', { class: `pill pill-${status.toLowerCase()}`, text: status });
}

// ─────────────────────────────── Top-L2s TVS chart ───────────────────────────────
function renderScalingChart() {
    const wrap = document.getElementById('scalingChart'); if (!wrap) return;
    const top = state.l2beatProjects.filter(p => p.tvs > 0).sort((a, b) => b.tvs - a.tvs).slice(0, 15);
    if (state.l2beatMeta) document.getElementById('scalingMeta').textContent = `${state.l2beatMeta.count} projects · ${state.l2beatMeta.source}`;
    wrap.textContent = '';
    if (!top.length) { wrap.appendChild(el('div', { class: 'feed-empty', text: 'No scaling data.' })); return; }
    const max = top[0].tvs;
    for (const p of top) {
        const pct = Math.max(2, (p.tvs / max) * 100);
        const row = el('div', { class: 'bar-row', onclick: p.chainId != null ? () => openChainDetail(p.chainId) : null }, [
            el('div', { class: 'bar-label', text: p.displayName || p.slug }),
            el('div', { class: 'bar-track' }, [el('div', { class: 'bar-fill' })]),
            el('div', { class: 'bar-value mono', text: fmtUsd(p.tvs) })
        ]);
        const fill = row.querySelector('.bar-fill');
        fill.style.width = `${pct}%`;
        fill.style.background = `linear-gradient(90deg, var(--color-l2), #06b6d4)`;
        wrap.appendChild(row);
    }
}

// ─────────────────────────────── status pages (drawer links only) ───────────────────────────────
async function loadStatusPages() {
    try {
        const d = await api('/status-pages');
        for (const sp of d.statusPages || []) for (const id of sp.chainIds || []) state.statusPagesByChain.set(id, { id: sp.id, name: sp.name, url: sp.url });
    } catch { /* drawer just won't show a status link */ }
}

// ─────────────────────────────── Incidents (live WS) ───────────────────────────────
const STATUS_WORDS = ['Resolved', 'Completed', 'Monitoring', 'Verifying', 'Update', 'Identified', 'Investigating', 'Scheduled', 'In progress'];
// Statuses that close an incident/maintenance — used to know it's done.
const CLOSED_STATUSES = new Set(['resolved', 'completed', 'closed']);
// chains-status-news now emits a normalized `status` (and `ongoing`) on every
// event — exact for Atlassian/webhook sources, text-derived server-side for
// feed-only providers. Prefer it; the summary-scraping below is only a fallback
// for older cached events that predate the field. Maps the wire vocabulary
// (src/incidentState.js STATUS) to the display label the cards already use.
const SERVER_STATUS_LABEL = {
    investigating: 'Investigating', identified: 'Identified', monitoring: 'Monitoring', resolved: 'Resolved',
    maintenance_scheduled: 'Scheduled', maintenance_in_progress: 'In progress', maintenance_completed: 'Completed',
    operational: 'Operational', degraded: 'Degraded', partial_outage: 'Partial outage', major_outage: 'Major outage'
};
const SCHEDULED_STATUSES = new Set(['maintenance_scheduled', 'maintenance_in_progress', 'maintenance_completed']);
const incidents = {
    items: [], byKey: new Map(), ws: null, retries: 0, groupBy: 'flat', dayFilter: null, category: 'all',
    // LLM enrichment (chains-status-news two-phase delivery): raw items arrive as
    // status.item, a status.enrichment (keyed by the raw eventId) follows later.
    // eventToKey resolves an eventId to its incident; enrichByKey holds the newest
    // enrichment per incident; enrichPending stashes any that arrive before the item.
    eventToKey: new Map(), enrichByKey: new Map(), enrichPending: new Map(), enrichTimer: null
};
const providers = { filter: 'all', dayFilter: null };

function parseIncidentStatus(ev) {
    const label = SERVER_STATUS_LABEL[ev.status];
    if (label) return label;
    const s = ev.summary || '';
    const m = s.match(new RegExp(`<strong>\\s*(${STATUS_WORDS.join('|')})\\s*</strong>`, 'i'));
    if (m) return m[1];
    const m2 = s.match(/Status:\s*([a-z ]+?)(?:\s*\||$)/i);
    if (m2) return m2[1].trim();
    return null;
}
// Incident vs scheduled maintenance. The server's structured status decides it
// when present; otherwise fall back to text — incident lifecycle words win (so
// an "Investigating…" event isn't miscategorised), then maintenance/upgrade
// signals mark it scheduled.
function classifyKind(ev) {
    if (SCHEDULED_STATUSES.has(ev.status)) return 'scheduled';
    if (SERVER_STATUS_LABEL[ev.status]) return 'incident';
    const blob = `${ev.title || ''} ${ev.summary || ''}`;
    if (/\b(Investigating|Identified|Monitoring)\b/i.test(blob)) return 'incident';
    if (/\b(Scheduled|Maintenance|Verifying|Completed|In progress)\b/i.test(blob) || /maintenance|upgrade|planned/i.test(ev.title || '')) return 'scheduled';
    return 'incident';
}
function parseIncidentTimes(ev) {
    const s = ev.summary || '';
    const year = (ev.publishedAt ? new Date(ev.publishedAt) : new Date()).getUTCFullYear();
    const stamps = [...s.matchAll(/<small>([\s\S]*?)<\/small>/gi)]
        .map(x => {
            // Pull the visible tokens (month word, day, HH:MM) directly from the
            // <small> content — e.g. "Jun <var…>26</var>, <var…>20:03</var> UTC".
            // We only need to parse a date, so extract tokens instead of
            // stripping tags (tag-stripping is brittle and only used here for
            // a non-HTML purpose).
            const inner = x[1];
            const month = (inner.match(/[A-Za-z]{3,}/) || [])[0];
            const nums = inner.match(/\d{1,2}:\d{2}|\d{1,2}/g) || [];
            const day = nums.find(n => !n.includes(':'));
            const time = nums.find(n => n.includes(':'));
            if (!month || !day || !time) return null;
            const d = new Date(`${month} ${day} ${year} ${time}:00 UTC`);
            return Number.isNaN(d.getTime()) ? null : d.getTime();
        }).filter(v => v != null);
    if (stamps.length >= 2) return { start: Math.min(...stamps), end: Math.max(...stamps) };
    // ISO fallback (e.g. "Resolved: 2026-06-26 18:49:13")
    const iso = [...s.matchAll(/(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})/g)].map(x => Date.parse(x[1].replace(' ', 'T') + 'Z')).filter(Boolean);
    if (iso.length >= 2) return { start: Math.min(...iso), end: Math.max(...iso) };
    return null;
}
// One incident = one block, keyed by status page + title. The feed emits a
// separate event per poll/update for the same incident; we merge them, keep the
// latest status, and measure the open span across all the events we've seen.
function incidentKey(ev) {
    const sp = ev.statusPage?.id || (ev.chains?.[0]?.chainId ?? 'unknown');
    return `${sp}|${(ev.title || '').toLowerCase().trim()}`;
}
function eventTimeMs(ev) {
    const t = Date.parse(ev.publishedAt || ev.updatedAt || '');
    return Number.isNaN(t) ? null : t;
}
function incidentModel(ev) {
    const chain = ev.chains?.[0];
    const whenMs = eventTimeMs(ev);
    const isProvider = ev.statusPage?.kind === 'rpc-provider';
    return {
        key: incidentKey(ev),
        title: ev.title || '(untitled)',
        url: ev.url,
        whenMs,
        firstSeen: whenMs,
        lastSeen: whenMs,
        status: parseIncidentStatus(ev),
        // Authoritative active/resolved flag from the feed; null on older cached
        // events, where the card falls back to matching the status label.
        ongoing: typeof ev.ongoing === 'boolean' ? ev.ongoing : null,
        kind: classifyKind(ev),
        durationMs: (() => { const t = parseIncidentTimes(ev); return t ? t.end - t.start : null; })(),
        netName: chain?.name || ev.statusPage?.name || ev.statusPage?.id || 'Unknown',
        chainId: chain?.chainId ?? null,
        spId: ev.statusPage?.id || (chain?.chainId != null ? String(chain.chainId) : 'unknown'),
        // RPC provider incidents (Infura, QuickNode, dRPC, Pinax) get their own
        // tab; one provider status page can affect many chains per incident.
        isProvider,
        provider: isProvider ? (ev.statusPage?.id || 'unknown') : null,
        providerName: isProvider ? (ev.statusPage?.name || ev.statusPage?.id || 'Provider') : null,
        affectedChains: isProvider ? (ev.chains || []).map(c => c.chainId).filter(id => id != null) : [],
        affectedComponents: Array.isArray(ev.affectedComponents) ? ev.affectedComponents : []
    };
}
function dayKey(ms) { return ms != null && !Number.isNaN(ms) ? new Date(ms).toISOString().slice(0, 10) : null; }

function addIncidents(events) {
    let changed = false;
    for (const ev of events) {
        const m = incidentModel(ev);
        // Remember which incident this raw event belongs to so a later
        // status.enrichment (keyed by eventId) attaches to the right card; drain
        // any enrichment that raced ahead of its item.
        if (ev.id) {
            incidents.eventToKey.set(ev.id, m.key);
            const early = incidents.enrichPending.get(ev.id);
            if (early) { incidents.enrichPending.delete(ev.id); applyEnrichment(m.key, early); }
        }
        const existing = incidents.byKey.get(m.key);
        if (!existing) { incidents.byKey.set(m.key, m); changed = true; continue; }
        // merge into the single block for this incident
        if (m.whenMs != null) {
            existing.firstSeen = Math.min(existing.firstSeen ?? m.whenMs, m.whenMs);
            existing.lastSeen = Math.max(existing.lastSeen ?? m.whenMs, m.whenMs);
            if (existing.whenMs == null || m.whenMs >= existing.whenMs) { // newest event wins for current status
                existing.whenMs = m.whenMs; existing.status = m.status; existing.ongoing = m.ongoing; existing.url = m.url; existing.kind = m.kind;
                if (m.affectedChains.length) existing.affectedChains = m.affectedChains;
                if (m.affectedComponents.length) existing.affectedComponents = m.affectedComponents;
            }
        }
        changed = true;
    }
    if (!changed) return;
    for (const m of incidents.byKey.values()) {
        // Prefer the observed open span (first→last update); fall back to the
        // duration parsed from a single summary.
        if (m.firstSeen != null && m.lastSeen != null && m.lastSeen > m.firstSeen) m.durationMs = m.lastSeen - m.firstSeen;
    }
    incidents.items = [...incidents.byKey.values()].sort((a, b) => (b.whenMs || 0) - (a.whenMs || 0));
    try { renderIncidents(); } catch (err) { console.error('incident render failed', err); }
    try { renderProviders(); } catch (err) { console.error('provider render failed', err); }
}

// A status.enrichment frame: the LLM classification/summary for one event,
// delivered after its status.item. Attach it to the event's incident (or stash
// it if the item hasn't landed yet) and repaint.
function addEnrichment(enr) {
    const key = incidents.eventToKey.get(enr.eventId);
    if (!key) { incidents.enrichPending.set(enr.eventId, enr); return; }
    if (applyEnrichment(key, enr)) scheduleEnrichmentRerender();
}
// Newest enrichment wins per incident (a later update can re-classify it).
function applyEnrichment(key, enr) {
    const prev = incidents.enrichByKey.get(key);
    if (prev && (Date.parse(prev.createdAt) || 0) >= (Date.parse(enr.createdAt) || 0)) return false;
    incidents.enrichByKey.set(key, enr);
    return true;
}
// Enrichments burst (WS replay re-sends them); coalesce the repaint.
function scheduleEnrichmentRerender() {
    if (incidents.enrichTimer) return;
    incidents.enrichTimer = setTimeout(() => {
        incidents.enrichTimer = null;
        try { renderIncidents(); } catch (err) { console.error('incident render failed', err); }
        try { renderProviders(); } catch (err) { console.error('provider render failed', err); }
    }, 300);
}

// The Incidents tab covers chain operator status pages; RPC provider status
// pages live in their own Providers tab. Items after the active category filter.
function visibleIncidents() {
    const chainIncidents = incidents.items.filter(it => !it.isProvider);
    if (incidents.category === 'all') return chainIncidents;
    return chainIncidents.filter(it => it.kind === incidents.category);
}

function initIncidentControls() {
    document.getElementById('grpFlat')?.addEventListener('click', () => setGroupBy('flat'));
    document.getElementById('grpNetwork')?.addEventListener('click', () => setGroupBy('network'));
    document.querySelectorAll('#incidentCategory .chip').forEach(chip =>
        chip.addEventListener('click', () => setCategory(chip.dataset.cat)));
}
function setGroupBy(mode) {
    incidents.groupBy = mode;
    document.getElementById('grpFlat')?.classList.toggle('active', mode === 'flat');
    document.getElementById('grpNetwork')?.classList.toggle('active', mode === 'network');
    renderIncidentList();
}
function setCategory(cat) {
    incidents.category = cat;
    document.querySelectorAll('#incidentCategory .chip').forEach(c => c.classList.toggle('active', c.dataset.cat === cat));
    renderIncidents();
}

function renderIncidents() {
    renderCalendar();
    renderIncidentList();
}

// Three real month grids — previous, current, next (next month surfaces
// upcoming scheduled maintenance). Monday-first, UTC day keys (matches
// dayKey()), days with events are heat-shaded and click-toggle a day filter.
function renderMonthCalendars(containerId, items, selectedDay, onSelect) {
    const wrap = document.getElementById(containerId); if (!wrap) return;
    const counts = new Map();
    for (const it of items) { const k = dayKey(it.whenMs); if (k) counts.set(k, (counts.get(k) || 0) + 1); }
    const max = Math.max(1, ...counts.values());
    const todayKey = dayKey(Date.now());
    const now = new Date();
    wrap.textContent = '';
    for (let off = -1; off <= 1; off++) {
        const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + off, 1));
        const daysInMonth = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
        const grid = el('div', { class: 'cal-grid' },
            ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map(d => el('div', { class: 'cal-dow', text: d })));
        for (let i = (first.getUTCDay() + 6) % 7; i > 0; i--) grid.appendChild(el('div', { class: 'cal-cell blank' }));
        for (let d = 1; d <= daysInMonth; d++) {
            const k = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), d)).toISOString().slice(0, 10);
            const n = counts.get(k) || 0;
            const cell = el('div', {
                class: `cal-cell${n ? ' has' : ''}${selectedDay === k ? ' sel' : ''}${k === todayKey ? ' today' : ''}`,
                title: `${k}: ${n} incident${n === 1 ? '' : 's'}`
            }, [
                el('span', { class: 'cal-day', text: String(d) }),
                n ? el('span', { class: 'cal-count', text: String(n) }) : null
            ]);
            if (n) { cell.style.background = `rgba(139,92,246,${0.15 + 0.6 * (n / max)})`; cell.addEventListener('click', () => onSelect(k)); }
            grid.appendChild(cell);
        }
        wrap.appendChild(el('div', { class: 'cal-month' }, [
            el('div', { class: 'cal-month-title', text: first.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }) }),
            grid
        ]));
    }
}

function renderCalendar() {
    renderMonthCalendars('incidentCalendar', visibleIncidents(), incidents.dayFilter,
        k => { incidents.dayFilter = incidents.dayFilter === k ? null : k; renderIncidents(); });
}

// One card builder for both chain incidents and provider incidents — they
// differ only in icon/label source and the affected-chains chip row.
function incidentCard(it) {
    const isProvider = !!it.isProvider;
    const label = isProvider ? it.providerName : it.netName;
    const enr = incidents.enrichByKey.get(it.key) || null;
    const enrAction = enr?.context?.actionRequired && String(enr.context.actionRequired).toLowerCase() !== 'none'
        ? enr.context.actionRequired : null;
    const open = it.ongoing != null
        ? it.ongoing
        : Boolean(it.status && !CLOSED_STATUSES.has(it.status.toLowerCase()));
    const when = it.whenMs != null ? new Date(it.whenMs).toLocaleString() : null;
    const meta = [label, when, open ? 'ongoing' : null].filter(Boolean);
    const dur = fmtDuration(it.durationMs);
    const side = [];
    // The LLM severity is the strongest at-a-glance signal — lead the rail with it.
    if (enr?.severity) side.push(el('span', { class: `pill sev-${String(enr.severity).toLowerCase()}`, text: enr.severity }));
    if (it.status) side.push(el('span', { class: `pill st-${it.status.toLowerCase().replace(/\s+/g, '')}`, text: it.status }));
    if (dur) side.push(el('span', { class: 'incident-dur', text: dur }));

    // Provider incidents map to the chains they hit: clickable chips (open the
    // drawer), else raw component names, else a "provider-wide" note.
    let affected = null;
    if (isProvider) {
        if (it.affectedChains?.length) {
            affected = el('div', { class: 'affected-chains' }, it.affectedChains.slice(0, 12).map(id => {
                const c = state.byId.get(id);
                return el('span', { class: 'chain-chip', onclick: e => { e.preventDefault(); e.stopPropagation(); openChainDetail(id); }, text: c?.name || `Chain ${id}` });
            }));
        } else if (it.affectedComponents?.length) {
            affected = el('div', { class: 'incident-meta muted', text: it.affectedComponents.slice(0, 5).join(', ') });
        } else {
            affected = el('div', { class: 'incident-meta muted', text: 'No specific chain — provider-wide' });
        }
    }

    return el('a', { class: `incident-card${open ? ' open' : ''}`, href: it.url || '#', target: '_blank', rel: 'noopener' }, [
        isProvider ? networkIcon(label, COLORS.Default, 'net-icon provider-icon') : networkIcon(label, iconColorFor(it.chainId)),
        el('div', { class: 'incident-body' }, [
            el('div', { class: 'incident-title' }, [
                !isProvider && it.kind === 'scheduled' ? el('span', { class: 'kind-tag', text: 'Scheduled' }) : null,
                el('span', { text: it.title })
            ]),
            el('div', { class: 'incident-meta', text: meta.join(' · ') }),
            // LLM enrichment (chains-status-news): plain-language summary + any
            // required action. The "AI" tag carries class/confidence/model on hover.
            enr?.summary ? el('div', { class: 'incident-ai' }, [
                el('span', {
                    class: 'ai-tag', text: 'AI',
                    title: [enr.class, enr.confidence != null ? `${Math.round(enr.confidence * 100)}%` : null, enr.model]
                        .filter(Boolean).join(' · ')
                }),
                el('span', { class: 'ai-summary', text: enr.summary })
            ]) : null,
            enrAction ? el('div', { class: 'incident-action', text: `Action: ${enrAction}` }) : null,
            affected
        ]),
        el('div', { class: 'incident-side' }, side)
    ]);
}

function renderIncidentList() {
    const list = document.getElementById('incidentsList'); if (!list) return;
    let items = visibleIncidents();
    if (incidents.dayFilter) items = items.filter(it => dayKey(it.whenMs) === incidents.dayFilter);
    if (searchQuery) items = items.filter(it => it.netName?.toLowerCase().includes(searchQuery) || it.title?.toLowerCase().includes(searchQuery) || String(it.chainId).includes(searchQuery));
    const noun = incidents.category === 'scheduled' ? 'maintenance' : 'incident';
    document.getElementById('incidentsCount').textContent =
        `${items.length} ${noun}${items.length === 1 ? '' : 's'}${incidents.dayFilter ? ` on ${incidents.dayFilter}` : ''}${searchQuery ? ` · “${searchQuery}”` : ''}`;
    list.textContent = '';
    if (!items.length) { list.appendChild(el('div', { class: 'feed-empty', text: 'Nothing in this range.' })); return; }

    if (incidents.groupBy === 'network') {
        const groups = new Map();
        for (const it of items) { if (!groups.has(it.spId)) groups.set(it.spId, []); groups.get(it.spId).push(it); }
        const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
        for (const [, arr] of ordered) {
            const head = arr[0];
            list.appendChild(el('div', { class: 'incident-group-head' }, [
                networkIcon(head.netName, iconColorFor(head.chainId), 'net-icon sm'),
                el('span', { class: 'cell-name', text: head.netName }),
                el('span', { class: 'muted', text: `${arr.length} event${arr.length === 1 ? '' : 's'}` })
            ]));
            for (const it of arr) list.appendChild(incidentCard(it));
        }
    } else {
        for (const it of items) list.appendChild(incidentCard(it));
    }
}

// ─────────────────────────────── RPC providers (live WS) ───────────────────────────────
// Same feed as Incidents; provider items (statusPage.kind === 'rpc-provider')
// are split out here and grouped by provider, each showing the chains it hit.
function providerIncidents() { return incidents.items.filter(it => it.isProvider); }
function visibleProviderIncidents() {
    const all = providerIncidents();
    return providers.filter === 'all' ? all : all.filter(it => it.provider === providers.filter);
}
function providerMatchesSearch(it, q) {
    if (it.providerName?.toLowerCase().includes(q) || it.title?.toLowerCase().includes(q)) return true;
    if ((it.affectedComponents || []).some(c => c.toLowerCase().includes(q))) return true;
    return (it.affectedChains || []).some(id => String(id).includes(q) || state.byId.get(id)?.name?.toLowerCase().includes(q));
}

function setProviderFilter(prov) {
    providers.filter = prov;
    renderProviders();
}

function renderProviders() {
    renderProviderCalendar();
    renderProviderFilter();
    renderProviderList();
}

function renderProviderCalendar() {
    renderMonthCalendars('providerCalendar', visibleProviderIncidents(), providers.dayFilter,
        k => { providers.dayFilter = providers.dayFilter === k ? null : k; renderProviders(); });
}

function renderProviderFilter() {
    const bar = document.getElementById('providerFilter'); if (!bar) return;
    const all = providerIncidents();
    const counts = new Map(), names = new Map();
    for (const it of all) { counts.set(it.provider, (counts.get(it.provider) || 0) + 1); if (!names.has(it.provider)) names.set(it.provider, it.providerName); }
    bar.textContent = '';
    const chip = (prov, label) => el('button', { class: `chip${providers.filter === prov ? ' active' : ''}`, 'data-prov': prov, onclick: () => setProviderFilter(prov), text: label });
    bar.appendChild(chip('all', `All (${all.length})`));
    for (const [id, name] of [...names].sort((a, b) => (a[1] || '').localeCompare(b[1] || '')))
        bar.appendChild(chip(id, `${name} (${counts.get(id) || 0})`));
}

function renderProviderList() {
    const list = document.getElementById('providersList'); if (!list) return;
    let items = visibleProviderIncidents();
    if (providers.dayFilter) items = items.filter(it => dayKey(it.whenMs) === providers.dayFilter);
    if (searchQuery) items = items.filter(it => providerMatchesSearch(it, searchQuery));
    const countEl = document.getElementById('providersCount');
    if (countEl) countEl.textContent = `${items.length} incident${items.length === 1 ? '' : 's'}${providers.dayFilter ? ` on ${providers.dayFilter}` : ''}${searchQuery ? ` · “${searchQuery}”` : ''}`;
    list.textContent = '';
    if (!items.length) {
        list.appendChild(el('div', { class: 'feed-empty', text: providerIncidents().length ? 'Nothing matches.' : 'No RPC provider incidents in range.' }));
        return;
    }
    for (const it of items) list.appendChild(incidentCard(it));
}

function connectStatusFeed() {
    // The WS replay is capped server-side (~100 events, a few days), so the
    // full history always comes from the REST backfill; the WS only streams
    // live updates on top. addIncidents() merges the two by incident key.
    statusFeedBackfill();
    setFeedLive(false); // red until the socket opens
    const wsUrl = `${STATUS_NEWS_BASE.replace(/^http/, 'ws')}/ws?replay=100`;
    let ws;
    try { ws = new WebSocket(wsUrl); } catch { return; }
    incidents.ws = ws;
    ws.onopen = () => { incidents.retries = 0; setFeedLive(true); statusFeedBackfill(); };
    ws.onmessage = ev => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'status.item' && m.item) addIncidents([m.item]);
        else if (m.type === 'status.enrichment' && m.eventId) addEnrichment(m);
    };
    ws.onerror = () => { try { ws.close(); } catch { /* noop */ } };
    ws.onclose = () => {
        incidents.ws = null;
        setFeedLive(false); // dropped — not receiving live updates until reconnect
        if (incidents.retries < 6) { const delay = Math.min(1000 * 2 ** incidents.retries, 20000); incidents.retries++; setTimeout(connectStatusFeed, delay); }
    };
}
function setFeedLive(live) { setLiveDot(['incidentsMeta', 'providersMeta'], live); }

// Render a green (connected, receiving live updates) / red (disconnected) dot
// next to the "live" label in a feed's status pill.
function setLiveDot(ids, live) {
    for (const id of [].concat(ids)) {
        const e = document.getElementById(id);
        if (!e) continue;
        e.className = 'src-pill live-pill';
        e.textContent = '';
        e.appendChild(el('span', { class: `live-dot ${live ? 'on' : 'off'}`, title: live ? 'Live — receiving real-time updates' : 'Disconnected from the live feed' }));
        e.appendChild(document.createTextNode('live'));
    }
}
async function statusFeedBackfill() {
    if (incidents.backfilled || incidents.backfillInFlight) return;
    incidents.backfillInFlight = true;
    try {
        // limit=500 > store size — returns everything the feed has retained.
        const res = await fetch(`${STATUS_NEWS_BASE}/events?limit=500`, { headers: { accept: 'application/json' } });
        if (!res.ok) throw new Error(res.status);
        const d = await res.json();
        addIncidents(d.events || d.items || []);
        incidents.backfilled = true;
    } catch {
        if (!incidents.items.length) { const l = document.getElementById('incidentsList'); if (l) { l.textContent = ''; l.appendChild(el('div', { class: 'feed-empty', text: 'Live status feed unavailable (chains-status-news).' })); } }
    } finally {
        incidents.backfillInFlight = false;
    }
}

// ─────────────────────────────── Forum activity (treemap by forum) ───────────────────────────────
// Posts are grouped by forum (one forum can front several chains) and drawn as
// a squarified treemap: tile area ∝ post volume, colour ∝ weekly momentum.
// threads: canonical thread key → newest normalized post. Seeded from REST,
// then kept live by the WS. byForum is the grouped view derived from it.
const forum = { threads: new Map(), byForum: new Map(), loaded: false, loading: false, filter: null, ws: null, retries: 0, rerenderTimer: null };
const FORUM_TREEMAP_HEIGHT = 520;

// Canonical thread id for a forum post URL — the feed can emit one thread from
// two registry entries whose URLs differ only by #fragment / ?page.
function forumThreadKey(u) { try { const x = new URL(u); return x.origin + x.pathname; } catch { return u; } }

function ensureForumView() {
    if (forum.loaded) { renderForumTreemap(); return; } // re-fit to current width
    if (forum.loading) return;
    forum.loading = true;
    setForumLive(false);
    loadForumFeed();
}

function setForumLive(live) { setLiveDot('forumMeta', live); }

async function loadForumFeed() {
    try {
        const res = await fetch(`${FORUM_NEWS_BASE}/news?limit=500`, { headers: { accept: 'application/json' } });
        if (!res.ok) throw new Error(res.status);
        for (const p of (await res.json()).news || []) upsertForumPost(p);
        regroupForum();
        forum.loaded = true;
    } catch {
        const list = document.getElementById('forumList');
        if (list) { list.textContent = ''; list.appendChild(el('div', { class: 'feed-empty', text: 'Forum feed unavailable (chains-forum-news).' })); }
        return;
    } finally {
        forum.loading = false;
    }
    renderForumTreemap();
    renderForumList();
    connectForumFeed(); // stream live updates on top of the REST seed
}

// Live forum feed: same pattern as the status feed — REST seed above, then a
// WS streams new posts. The dot goes green only while the socket is open.
function connectForumFeed() {
    setForumLive(false); // red until the socket opens
    const wsUrl = `${FORUM_NEWS_BASE.replace(/^http/, 'ws')}/ws?replay=1`;
    let ws;
    try { ws = new WebSocket(wsUrl); } catch { return; }
    forum.ws = ws;
    ws.onopen = () => { forum.retries = 0; setForumLive(true); };
    ws.onmessage = ev => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'news.item' && m.item && upsertForumPost(m.item)) scheduleForumRerender();
    };
    ws.onerror = () => { try { ws.close(); } catch { /* noop */ } };
    ws.onclose = () => {
        forum.ws = null;
        setForumLive(false);
        if (forum.retries < 6) { const delay = Math.min(1000 * 2 ** forum.retries, 20000); forum.retries++; setTimeout(connectForumFeed, delay); }
    };
}

// Merge one raw feed post into the thread store; returns true if it changed
// anything (new thread or a newer revision of an existing one).
function upsertForumPost(p) {
    const whenMs = Date.parse(p.publishedAt || p.updatedAt || '');
    const item = {
        title: p.title || '(untitled)',
        url: p.url || '#',
        whenMs: Number.isNaN(whenMs) ? null : whenMs,
        forumId: p.forum?.id || 'unknown',
        forumName: p.forum?.name || p.forum?.id || 'Forum',
        chains: Array.isArray(p.chains) ? p.chains.filter(c => c?.chainId != null) : []
    };
    const key = forumThreadKey(item.url);
    const prev = forum.threads.get(key);
    if (prev && (prev.whenMs || 0) >= (item.whenMs || 0)) return false;
    forum.threads.set(key, item);
    return true;
}

function regroupForum() {
    const posts = [...forum.threads.values()].sort((a, b) => (b.whenMs || 0) - (a.whenMs || 0));
    forum.byForum = groupByForum(posts);
}

// WS replay can burst; coalesce re-renders so a batch of pushes repaints once.
function scheduleForumRerender() {
    if (forum.rerenderTimer) return;
    forum.rerenderTimer = setTimeout(() => {
        forum.rerenderTimer = null;
        regroupForum();
        if (activeView === 'forum') { renderForumTreemap(); renderForumList(); }
    }, 400);
}

function groupByForum(posts) {
    const now = Date.now();
    const WEEK = 7 * 86400 * 1000;
    const map = new Map();
    for (const p of posts) {
        if (!map.has(p.forumId)) map.set(p.forumId, { id: p.forumId, name: p.forumName, chainMap: new Map(), posts: [], recent: 0, prior: 0 });
        const g = map.get(p.forumId);
        g.posts.push(p);
        // Union affected chains across all of the forum's posts (not just the
        // first) — otherwise chips miss chains only referenced by older posts.
        for (const c of p.chains) if (!g.chainMap.has(c.chainId)) g.chainMap.set(c.chainId, c);
        // Momentum window: posts this week vs the week before. `age >= 0`
        // guards clock-skewed / future feed timestamps from faking "recent".
        if (p.whenMs != null) {
            const age = now - p.whenMs;
            if (age >= 0 && age < WEEK) g.recent++;
            else if (age >= WEEK && age < 2 * WEEK) g.prior++;
        }
    }
    // momentum ∈ [-1, 1]: heating up (recent > prior) → +, cooling → −.
    for (const g of map.values()) {
        g.chains = [...g.chainMap.values()];
        g.momentum = g.prior > 0 ? clampMomentum((g.recent - g.prior) / g.prior)
            : g.recent > 0 ? 1 : 0;
    }
    // Busiest forums first.
    return new Map([...map.entries()].sort((a, b) => b[1].posts.length - a[1].posts.length));
}

function clampMomentum(m) { return Math.max(-1, Math.min(1, m)); }

// Tile fill: red (cooling) → neutral → green (heating), intensity by magnitude.
function momentumColor(m) {
    if (m > 0.05) { const t = Math.min(1, m); return `rgba(34,197,94,${0.22 + 0.55 * t})`; }
    if (m < -0.05) { const t = Math.min(1, -m); return `rgba(239,68,68,${0.22 + 0.55 * t})`; }
    return 'rgba(130,130,150,0.28)';
}

// Squarified treemap (Bruls, Huizing & van Wijk) — lays out tiles so each
// stays close to square, area ∝ value. Pure geometry, no external lib.
function squarifyTreemap(children, x, y, w, h) {
    const out = [];
    const nodes = children.filter(c => c.value > 0).sort((a, b) => b.value - a.value);
    const total = nodes.reduce((s, c) => s + c.value, 0);
    if (total <= 0 || w <= 0 || h <= 0) return out;
    const items = nodes.map(c => ({ ref: c, area: (c.value / total) * (w * h) }));

    const worst = (row, side) => {
        const sum = row.reduce((s, r) => s + r.area, 0);
        let mx = -Infinity, mn = Infinity;
        for (const r of row) { if (r.area > mx) mx = r.area; if (r.area < mn) mn = r.area; }
        const s2 = sum * sum, l2 = side * side;
        return Math.max((l2 * mx) / s2, s2 / (l2 * mn));
    };

    const rect = { x, y, w, h };
    let i = 0;
    while (i < items.length) {
        const side = Math.min(rect.w, rect.h);
        const row = [items[i]];
        let j = i + 1;
        while (j < items.length && worst(row, side) >= worst(row.concat(items[j]), side)) {
            row.push(items[j]); j++;
        }
        const rowArea = row.reduce((s, r) => s + r.area, 0);
        if (rect.w <= rect.h) {
            const rh = rowArea / rect.w;
            let cx = rect.x;
            for (const r of row) { const rw = r.area / rh; out.push({ ref: r.ref, x: cx, y: rect.y, w: rw, h: rh }); cx += rw; }
            rect.y += rh; rect.h -= rh;
        } else {
            const rw = rowArea / rect.h;
            let cy = rect.y;
            for (const r of row) { const rh = r.area / rw; out.push({ ref: r.ref, x: rect.x, y: cy, w: rw, h: rh }); cy += rh; }
            rect.x += rw; rect.w -= rw;
        }
        i = j;
    }
    return out;
}

function renderForumTreemap() {
    const wrap = document.getElementById('forumTreemap'); if (!wrap) return;
    wrap.textContent = '';
    if (!forum.byForum.size) return;
    const width = wrap.clientWidth || 900;
    const height = FORUM_TREEMAP_HEIGHT;
    // Size tiles by the posts that match the active search (drop forums with no
    // match). searchQuery is global — a term left in the box or restored from
    // ?q= filters the list below, so an unfiltered treemap would show full tiles
    // whose clicks land on "0 posts". Filtering here keeps tiles and list in
    // lockstep: every visible tile has clickable posts.
    const nodes = [...forum.byForum.values()]
        .map(g => ({ g, value: searchQuery ? g.posts.filter(p => forumMatchesSearch(p, searchQuery)).length : g.posts.length }))
        .filter(n => n.value > 0);
    const tiles = squarifyTreemap(nodes, 0, 0, width, height);
    const gap = 2;
    for (const t of tiles) {
        const g = t.ref.g;
        const n = t.ref.value; // posts matching the current search (or total when unsearched)
        const active = forum.filter === g.id;
        // With a search active, every rendered tile is a match — spotlight them
        // so filtering by a chain visibly focuses that chain's forum in the map.
        const focused = Boolean(searchQuery);
        const tile = el('button', {
            class: `tm-tile${active ? ' active' : ''}${focused ? ' focus' : ''}`,
            title: `${g.name} — ${n} posts · ${g.recent} this week${g.momentum > 0.05 ? ' (heating up)' : g.momentum < -0.05 ? ' (cooling)' : ''}`,
            onclick: () => { forum.filter = active ? null : g.id; renderForumTreemap(); renderForumList(); }
        });
        tile.style.left = `${t.x + gap / 2}px`;
        tile.style.top = `${t.y + gap / 2}px`;
        tile.style.width = `${Math.max(0, t.w - gap)}px`;
        tile.style.height = `${Math.max(0, t.h - gap)}px`;
        tile.style.background = momentumColor(g.momentum);
        // Label with the chain name (fall back to the forum name for forums
        // that map to no chain), centred; scale with tile size.
        if (t.w > 40 && t.h > 22) {
            const fs = Math.max(10, Math.min(20, Math.round(t.w / 9)));
            tile.appendChild(el('span', { class: 'tm-name', style: `font-size:${fs}px`, text: g.chains[0]?.name || g.name }));
        }
        wrap.appendChild(tile);
    }
    wrap.style.height = `${height}px`;
}

function forumMatchesSearch(p, q) {
    if (p.title.toLowerCase().includes(q) || p.forumName.toLowerCase().includes(q)) return true;
    return p.chains.some(c => String(c.chainId).includes(q) || (c.name || '').toLowerCase().includes(q));
}

function renderForumList() {
    const list = document.getElementById('forumList'); if (!list) return;
    if (!forum.loaded) return;
    const groups = [...forum.byForum.values()].filter(g => !forum.filter || g.id === forum.filter);
    const count = document.getElementById('forumCount');

    let shown = 0;
    list.textContent = '';
    for (const g of groups) {
        const posts = g.posts.filter(p => !searchQuery || forumMatchesSearch(p, searchQuery));
        if (!posts.length) continue;
        shown += posts.length;
        const chainChips = g.chains.slice(0, 6).map(c =>
            el('span', { class: 'chain-chip', onclick: () => openChainDetail(c.chainId), text: c.name || `Chain ${c.chainId}` }));
        list.appendChild(el('div', { class: 'forum-group-head' }, [
            el('span', { class: 'cell-name', text: g.name }),
            el('span', { class: 'muted', text: `${posts.length} post${posts.length === 1 ? '' : 's'}` }),
            el('div', { class: 'affected-chains', style: 'margin:0' }, chainChips)
        ]));
        for (const p of posts.slice(0, 20)) {
            list.appendChild(el('a', { class: 'incident-card', href: p.url, target: '_blank', rel: 'noopener' }, [
                el('div', { class: 'incident-body' }, [
                    el('div', { class: 'incident-title' }, [el('span', { text: p.title })]),
                    el('div', { class: 'incident-meta', text: [p.forumName, p.whenMs ? relTime(new Date(p.whenMs).toISOString()) : null].filter(Boolean).join(' · ') })
                ])
            ]));
        }
    }
    if (count) count.textContent = `${shown} post${shown === 1 ? '' : 's'}${forum.filter ? ` · ${forum.byForum.get(forum.filter)?.name || ''}` : ''}${searchQuery ? ` · “${searchQuery}”` : ''}`;
    if (!shown) list.appendChild(el('div', { class: 'feed-empty', text: 'Nothing matches.' }));
}

// ─────────────────────────────── Assistant (floating chat overlay) ───────────────────────────────
// A corner button opens a chat panel that floats over every view, so the user
// can ask about whatever they're looking at (the active view + open chain are
// sent as context). Conversation lives in memory only: persisting it to the
// URL would leak chat text into shareable links, and localStorage would
// resurrect stale conversations on a public dashboard.
const assistant = { messages: [], busy: false, enabled: null, disabledNoticeShown: false };

function initAssistant() {
    document.getElementById('assistantFab')?.addEventListener('click', () => toggleAssistant());
    document.getElementById('assistantClose')?.addEventListener('click', () => toggleAssistant(false));
    document.getElementById('assistantNew')?.addEventListener('click', () => resetAssistantChat());
    document.getElementById('assistantForm')?.addEventListener('submit', e => { e.preventDefault(); submitAssistantInput(); });
    document.getElementById('assistantInput')?.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitAssistantInput(); }
    });
    document.querySelectorAll('#assistantChips .chat-chip').forEach(chip =>
        chip.addEventListener('click', () => sendAssistantMessage(chip.textContent)));
    document.addEventListener('keydown', e => { if (e.key === 'Escape') toggleAssistant(false); });
}

function toggleAssistant(open) {
    const overlay = document.getElementById('assistantOverlay');
    if (!overlay) return;
    const show = open ?? overlay.classList.contains('hidden');
    overlay.classList.toggle('hidden', !show);
    document.getElementById('assistantFab')?.classList.toggle('fab-open', show);
    if (show) {
        probeAssistant(); // refresh the online/offline pill on every open (server caches ~30s)
        if (assistant.enabled !== false) document.getElementById('assistantInput')?.focus();
    }
}

async function probeAssistant() {
    // The pill shows live reachability (server pings the LLM, cached ~30s) —
    // not just whether the assistant is configured. No model info exposed.
    const meta = document.getElementById('assistantMeta');
    let online = false;
    try {
        const info = await api('/assistant');
        assistant.enabled = !!info.enabled;
        online = assistant.enabled && info.reachable !== false;
    } catch {
        assistant.enabled = false;
    }
    if (meta) {
        meta.textContent = online ? 'online' : 'offline';
        meta.className = `src-pill ${online ? 'pill-online' : 'pill-offline'}`;
    }
    if (!assistant.enabled && !assistant.disabledNoticeShown) {
        assistant.disabledNoticeShown = true;
        appendChatNotice('The assistant isn’t configured on this server yet (no LLM connected). Everything else on the dashboard works as usual.');
        setAssistantBusy(true); // permanently disable the form
    }
}

function submitAssistantInput() {
    const input = document.getElementById('assistantInput');
    const text = (input?.value || '').trim();
    if (!text) return;
    input.value = '';
    sendAssistantMessage(text);
}

async function sendAssistantMessage(text) {
    if (assistant.busy || assistant.enabled === false) return;
    document.getElementById('assistantChips')?.classList.add('hidden');
    assistant.messages.push({ role: 'user', content: text.slice(0, 4000) });
    // The server caps history at 20 messages; keep the newest turns.
    if (assistant.messages.length > 20) assistant.messages = assistant.messages.slice(-20);
    appendChatBubble('user', text);
    setAssistantBusy(true);
    const thinking = appendChatThinking();
    try {
        const context = { view: activeView, ...(openChainId != null ? { chainId: openChainId } : {}) };
        let res = await apiPost('/assistant/chat', { messages: assistant.messages, context });
        // Slow LLM runs come back as 202 + a job id — poll until the answer is
        // ready. Each poll is a fast request, so reverse-proxy timeouts that
        // would kill one long-held request never trigger. Poll responses carry
        // the harness's full step trace ("using search_chains", …) — show it.
        if (res.status === 202 && res.data?.jobId) {
            thinking.setSteps(assistantStepsFrom(res.data));
            res = await pollAssistantJob(res.data.jobId, res.data.pollAfterMs, res.data.budgetMs, thinking.setSteps);
        }
        thinking.remove();
        if (res.ok && res.data?.reply != null) {
            assistant.messages.push({ role: 'assistant', content: res.data.reply });
            appendChatBubble('assistant', res.data.reply, { toolCalls: res.data.toolCalls, degraded: res.data.degraded, viaFallback: res.data.viaFallback });
        } else if (res.status === 429) {
            appendChatNotice('Slow down a little — too many questions in a short time. Try again in a minute.');
        } else if (res.status === 503) {
            const msg = res.data?.error || '';
            appendChatNotice(msg === 'Assistant not configured' ? 'The assistant isn’t configured on this server.'
                : msg === 'Assistant LLM unreachable' || msg === 'Assistant failed' ? 'The assistant’s language model is unreachable right now. Try again shortly.'
                : msg || 'The assistant is unavailable right now. Try again shortly.');
        } else {
            appendChatNotice(res.data?.error || 'Something went wrong. Please try again.');
        }
    } catch {
        thinking.remove();
        appendChatNotice('Network error — the request didn’t reach the server. Please try again.');
    } finally {
        setAssistantBusy(assistant.enabled === false);
        document.getElementById('assistantInput')?.focus();
    }
}

// Poll an async chat job until it finishes. The window follows the server's
// declared per-request budget (202 budgetMs) plus a grace minute, capped at
// 15 min, defaulting to 5 min for older servers that don't send it — so a
// raised ASSISTANT_TIMEOUT_MS can't silently outlive the client. Returns the
// same {status, ok, data} shape as apiPost so the caller's branching is
// unchanged.
async function pollAssistantJob(jobId, pollAfterMs, budgetMs, onStep = () => {}) {
    const windowMs = Math.min((budgetMs || 4 * 60 * 1000) + 60 * 1000, 15 * 60 * 1000);
    const deadline = Date.now() + windowMs;
    const delay = Math.max(1000, pollAfterMs || 2000);
    let consecutiveMisses = 0;
    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, delay));
        // Each poll gets its own abort timeout — a single black-holed response
        // must not hang the loop past the deadline and strand the chat in the
        // busy state (same hazard api()/apiPost() guard against).
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15000);
        let res, data;
        try {
            res = await fetch(`${API_BASE}/assistant/chat/${jobId}`, { headers: { accept: 'application/json' }, signal: ctrl.signal });
            data = res.ok ? await res.json().catch(() => null) : null;
        } catch { continue; } // transient network blip or timeout — keep polling
        finally { clearTimeout(timer); }
        if (res.status === 404) {
            // Jobs live in ONE server replica's memory: behind a round-robin
            // load balancer a poll routinely lands on a pod that never heard
            // of this job. A miss is transient — keep polling, the next one
            // may hit the owner. Only a long unbroken run of misses means the
            // job is truly gone (pod restarted, TTL expired).
            if (++consecutiveMisses >= 15) {
                return { status: 503, ok: false, data: { error: 'The answer expired before it could be fetched. Please ask again.' } };
            }
            continue;
        }
        consecutiveMisses = 0;
        if (!res.ok) continue;
        if (data?.status === 'running') { onStep(assistantStepsFrom(data)); continue; }
        if (data?.status === 'error') return { status: 503, ok: false, data: { error: data.error } };
        if (data?.status === 'done') return { status: 200, ok: true, data };
    }
    return { status: 503, ok: false, data: { error: 'The assistant is taking too long. Please try again.' } };
}

function setAssistantBusy(busy) {
    assistant.busy = busy;
    for (const id of ['assistantSend', 'assistantInput', 'assistantNew']) {
        const el = document.getElementById(id);
        if (el) el.disabled = busy;
    }
}

function resetAssistantChat() {
    if (assistant.busy) return; // a run is in flight — its reply would land in the fresh chat
    assistant.messages = [];
    const log = document.getElementById('assistantLog');
    if (log) log.textContent = '';
    document.getElementById('assistantChips')?.classList.remove('hidden');
    document.getElementById('assistantInput')?.focus();
}

function appendChatBubble(role, text, { toolCalls, degraded, viaFallback } = {}) {
    const log = document.getElementById('assistantLog');
    const body = el('div', { class: 'chat-bubble-body' });
    body.innerHTML = renderAssistantMarkdown(text);
    const extras = [];
    // Clarifying questions list options as "- Name: chainId" lines (per the
    // system prompt) — turn them into one-tap quick-reply buttons.
    if (role === 'assistant') {
        const opts = parseChatOptions(text);
        if (opts.length) {
            extras.push(el('div', { class: 'chat-quick' },
                opts.map(o => el('button', { class: 'chip chat-quick-btn', text: o.label, onclick: () => sendAssistantMessage(o.reply) }))));
        }
    }
    if (degraded) extras.push(el('span', { class: 'chat-degraded', text: 'partial answer' }));
    if (viaFallback) extras.push(el('span', { class: 'chat-degraded', text: 'backup model' }));
    if (toolCalls?.length) {
        const names = [...new Set(toolCalls.map(c => c.name))].join(', ');
        extras.push(el('div', { class: 'chat-tools', text: `used: ${names}` }));
    }
    const bubble = el('div', { class: `chat-bubble ${role}` }, [body, ...extras]);
    log.appendChild(bubble);
    log.scrollTop = log.scrollHeight;
    return bubble;
}

// Extract "- Name: 8453" bullet option lines from a clarifying reply. The
// button label is the name; clicking sends "Name (8453)" so the follow-up is
// unambiguous to the model. The leading bullet ("- "/"* ") is REQUIRED so an
// ordinary answer line like "Chain ID: 8453" doesn't sprout a button, and the
// id allows up to 10 digits so 8-digit testnets (e.g. Sepolia 11155111) work.
function parseChatOptions(text) {
    const opts = [];
    const seen = new Set();
    for (const line of String(text).split('\n')) {
        const m = line.match(/^\s*[-*]\s+(.{1,48}?):\s*`?(\d{2,10})`?\s*$/);
        // Dedupe by numeric chain id (normalized, so "08453" and "8453" are
        // one) — a repeated option line must not become a duplicate button.
        const id = m && String(parseInt(m[2], 10));
        if (m && !seen.has(id)) {
            seen.add(id);
            opts.push({ label: m[1].trim(), reply: `${m[1].trim()} (${m[2]})` });
        }
        if (opts.length >= 6) break;
    }
    return opts;
}

function appendChatNotice(text) {
    const log = document.getElementById('assistantLog');
    const notice = el('div', { class: 'chat-notice', text });
    log.appendChild(notice);
    log.scrollTop = log.scrollHeight;
    return notice;
}

// Normalize a chat/poll payload's step trace across server versions: current
// servers send steps: [{label, at}], pre-1.7.4 send a single step string —
// during a Pages-before-API deploy window the new frontend must still narrate.
function assistantStepsFrom(data) {
    if (Array.isArray(data?.steps)) return data.steps.map(s => (typeof s === 'string' ? { label: s } : s));
    if (data?.step) return [{ label: data.step }];
    return null;
}

function appendChatThinking() {
    const log = document.getElementById('assistantLog');
    const trace = el('div', { class: 'chat-trace hidden' });
    const elapsed = el('span', { class: 'chat-elapsed' });
    const bubble = el('div', { class: 'chat-bubble assistant chat-thinking', 'aria-label': 'Assistant is thinking' }, [
        el('div', { class: 'chat-dots-row' }, [
            el('div', { class: 'chat-dots' }, [el('span'), el('span'), el('span')]),
            elapsed
        ]),
        trace
    ]);
    log.appendChild(bubble);
    log.scrollTop = log.scrollHeight;

    // Elapsed timer; cleared deterministically by wrapping remove() — every
    // exit path in sendAssistantMessage goes through thinking.remove().
    const startedAt = Date.now();
    const timer = setInterval(() => {
        elapsed.textContent = `${Math.round((Date.now() - startedAt) / 1000)}s`;
    }, 1000);
    const baseRemove = bubble.remove.bind(bubble);
    bubble.remove = () => { clearInterval(timer); baseRemove(); };

    // Renders the harness's full step trace: finished steps get a check and
    // their duration, the current one an arrow + animated ellipsis. Poll
    // responses carry the whole history, so brief steps are never missed.
    let renderedKey = null;
    bubble.setSteps = (steps) => {
        if (!Array.isArray(steps) || steps.length === 0) return;
        const last = steps[steps.length - 1];
        // Skip the rebuild when nothing changed — most polls during a long
        // "thinking" stretch. Rebuilding anyway would destroy text selection
        // in the trace for no reason.
        const key = `${steps.length}|${last.at ?? ''}|${last.label}`;
        if (key === renderedKey) return;
        renderedKey = key;
        // Only auto-scroll if the user is already at the bottom — never yank
        // them away from history they scrolled up to read.
        const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
        trace.textContent = '';
        steps.forEach((s, i) => {
            const current = i === steps.length - 1;
            const durMs = !current && s.at != null && steps[i + 1]?.at != null ? steps[i + 1].at - s.at : null;
            const text = current ? `${s.label}…`
                : durMs != null && durMs >= 100 ? `${s.label} (${(durMs / 1000).toFixed(1)}s)`
                : s.label;
            trace.appendChild(el('div', { class: `chat-trace-step${current ? ' active' : ' done'}` }, [
                el('span', { class: 'chat-trace-mark', text: current ? '›' : '✓' }),
                el('span', { text })
            ]));
        });
        trace.classList.remove('hidden');
        if (nearBottom) log.scrollTop = log.scrollHeight;
    };
    return bubble;
}

// Minimal markdown renderer for assistant replies. HTML-escapes FIRST, then
// layers formatting on the escaped text — so model output can never inject
// markup. Supports: `code`, **bold**, bullet lists, bare URLs, paragraphs.
function renderAssistantMarkdown(text) {
    const escaped = String(text)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const blocks = escaped.split(/\n{2,}/).map(block => {
        const lines = block.split('\n');
        const isList = lines.every(l => /^\s*[-*] /.test(l) || l.trim() === '');
        if (isList && lines.some(l => l.trim())) {
            const items = lines.filter(l => l.trim()).map(l => `<li>${inlineMd(l.replace(/^\s*[-*] /, ''))}</li>`).join('');
            return `<ul>${items}</ul>`;
        }
        return `<p>${lines.map(inlineMd).join('<br>')}</p>`;
    });
    return blocks.join('');
}

function inlineMd(s) {
    return s
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(https?:\/\/[^\s<)]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

// ─────────────────────────────── Detail drawer ───────────────────────────────
function initDrawer() {
    document.getElementById('closeDrawer')?.addEventListener('click', () => closeDrawer());
    document.getElementById('drawerScrim')?.addEventListener('click', () => closeDrawer());
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });
}
function closeDrawer(opts = {}) {
    document.getElementById('detailDrawer')?.classList.add('hidden');
    stopBlockHead();
    openChainId = null;
    if (!opts.fromUrl) updateUrl();
}
function chainLink(id) {
    const c = state.byId.get(id);
    return el('a', { class: 'chip-link', href: '#', text: c?.name || `Chain ${id}`, onclick: e => { e.preventDefault(); openChainDetail(id); } });
}
function detailRow(label, valueNode) {
    return el('div', { class: 'd-row' }, [el('span', { class: 'd-label', text: label }), el('div', { class: 'd-value' }, [].concat(valueNode))]);
}
function openChainDetail(chainId, opts = {}) {
    const c = state.byId.get(chainId); if (!c) return;
    openChainId = chainId;
    if (!opts.fromUrl) updateUrl();
    const body = document.getElementById('drawerBody');
    const type = classify(c);
    const e = state.rel.get(chainId) || {};
    const l2b = state.l2beat.get(chainId);
    const sp = state.statusPagesByChain.get(chainId);
    body.textContent = '';

    const icon = networkIcon(c.name, COLORS[type], 'd-icon');
    const badgeList = [el('span', { class: 'badge', text: `ID: ${c.chainId}` })];
    if (c.status) badgeList.push(statusBadge(c.status));
    (c.tags || []).forEach(t => badgeList.push(el('span', { class: `tag tag-${t.toLowerCase()}`, text: t })));
    const badges = el('div', { class: 'd-badges' }, badgeList);
    body.appendChild(el('div', { class: 'd-header' }, [icon, el('div', {}, [
        el('h2', { text: c.name || `Chain ${c.chainId}` }), badges
    ])]));

    const content = el('div', { class: 'd-content' });
    // Rows that need the full chain record land here — /summary is slim, so
    // detail (currency, explorers, website) is fetched per chain on open.
    const extraBox = el('div', { class: 'd-extra' });
    content.appendChild(extraBox);
    if (e.l1Parent != null) content.appendChild(detailRow('L1 / parent', chainLink(e.l1Parent)));
    if (e.mainnet != null) content.appendChild(detailRow('Mainnet', chainLink(e.mainnet)));
    if (e.l2Children?.length) content.appendChild(detailRow(`L2 / L3 (${e.l2Children.length})`, e.l2Children.slice(0, 30).map(chainLink)));
    if (e.testnetChildren?.length) content.appendChild(detailRow(`Testnets (${e.testnetChildren.length})`, e.testnetChildren.slice(0, 30).map(chainLink)));
    if (l2b) content.appendChild(detailRow('L2BEAT', el('div', { class: 'l2b-grid' }, [
        el('span', { class: 'pill pill-stage', text: l2b.stage || '—' }), el('span', { class: 'muted', text: l2b.category || '' }),
        el('span', { class: 'strong', text: fmtUsd(l2b.tvs) }), l2b.daLayer ? el('span', { class: 'muted', text: `DA: ${l2b.daLayer}` }) : null
    ])));
    if (sp) { const host = safeHost(sp.url); content.appendChild(detailRow('Status page', el('a', { href: sp.url, target: '_blank', rel: 'noopener', text: host || sp.name }))); }
    // Forum news row stays hidden unless this chain's forum actually has
    // recent posts — only ~60 of ~3000 chains have a tracked forum.
    const forumBox = el('div', { class: 'd-forum' });
    const forumRow = detailRow('Forum news', forumBox);
    forumRow.classList.add('hidden');
    content.appendChild(forumRow);
    loadChainDetail(chainId, extraBox, badges);
    loadForumNews(chainId, forumBox, forumRow);

    const headCell = el('span', { class: 'mono', text: '…' });
    content.appendChild(detailRow('Block head', headCell));
    const rpcBox = el('div', { class: 'd-rpc' }, [el('div', { class: 'd-rpc-loading', text: 'Checking RPC endpoints…' })]);
    content.appendChild(detailRow('RPC endpoints', rpcBox));
    const clientBox = el('div', { class: 'd-clients muted', text: '—' });
    content.appendChild(detailRow('Clients (live)', clientBox));

    body.appendChild(content);
    document.getElementById('detailDrawer').classList.remove('hidden');
    loadLiveRpc(chainId, rpcBox, headCell);
    loadLiveClients(chainId, clientBox);
}
// Fill the detail-only rows (currency, price, explorers, website, SLIP-44)
// from the full chain record. /summary is slim, so this usually needs a
// /chains/:id fetch; the /export fallback already carries everything.
async function loadChainDetail(chainId, box, badges) {
    let d = state.byId.get(chainId) || {};
    if (!d.nativeCurrency && !d.explorers && !d.infoURL) {
        try { d = await api(`/chains/${chainId}`); } catch { /* render what we have */ }
    }
    if (openChainId !== chainId) return; // drawer moved on while fetching
    box.textContent = '';
    const currency = d.nativeCurrency ? `${d.nativeCurrency.name} (${d.nativeCurrency.symbol})` : '—';
    const price = typeof d.price?.usd === 'number' ? ` · $${d.price.usd.toLocaleString()}` : '';
    box.appendChild(detailRow('Native currency', el('span', { text: currency + price })));
    if (d.status && !badges.querySelector('.pill')) badges.appendChild(statusBadge(d.status));
    if (d.explorers?.length) box.appendChild(detailRow('Explorers', d.explorers.slice(0, 6).map(x => el('a', { href: x.url, target: '_blank', rel: 'noopener', text: x.name || safeHost(x.url) }))));
    if (d.infoURL) { const host = safeHost(d.infoURL); box.appendChild(detailRow('Website', host ? el('a', { href: d.infoURL, target: '_blank', rel: 'noopener', text: host }) : el('span', { text: d.infoURL }))); }
    if (d.forumUrl) { const host = safeHost(d.forumUrl); box.appendChild(detailRow('Forum', el('a', { href: d.forumUrl, target: '_blank', rel: 'noopener', text: host || d.forumUrl }))); }
    if (d.slip44 != null) box.appendChild(detailRow('SLIP-44', el('span', { class: 'mono', text: String(d.slip44) })));
}

// "2026-07-05T…" → "3h ago" / "2d ago"
function relTime(iso) {
    const t = Date.parse(iso || '');
    if (Number.isNaN(t)) return '';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
}

// Recent community/governance posts for this chain from chains-forum-news.
// The row is revealed only when posts exist; any failure just leaves it hidden.
async function loadForumNews(chainId, box, row) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
        const res = await fetch(`${FORUM_NEWS_BASE}/news?chainId=${chainId}&limit=4`, { headers: { accept: 'application/json' }, signal: ctrl.signal });
        if (!res.ok) return;
        let posts = (await res.json()).news || [];
        // One row per thread — the feed can carry the same thread twice.
        posts = [...new Map(posts.map(p => [forumThreadKey(p.url), p])).values()].slice(0, 4);
        if (openChainId !== chainId || !posts.length) return; // drawer moved on / nothing to show
        box.textContent = '';
        for (const p of posts) {
            box.appendChild(el('div', { class: 'forum-post' }, [
                el('a', { href: p.url, target: '_blank', rel: 'noopener', text: p.title }),
                el('span', { class: 'muted forum-when', text: relTime(p.publishedAt) })
            ]));
        }
        row.classList.remove('hidden');
    } catch { /* row stays hidden */ }
    finally { clearTimeout(timer); }
}

// "Geth/v1.13.0/linux/go1.21" → "Geth v1.13.0"
function clientNameVersion(cv) {
    if (!cv) return null;
    return String(cv).split('/').slice(0, 2).join(' ').trim() || null;
}
async function loadLiveRpc(chainId, box, headCell) {
    stopBlockHead();
    const usable = urls => urls.map(u => typeof u === 'string' ? u : u?.url).filter(u => u && u.startsWith('http') && !u.includes('${'));
    let staticUrls = usable(state.byId.get(chainId)?.rpc || []);
    let results = [];
    // Health results + (when on slim /summary data) the registry URL list.
    const [healthRes, endpointsRes] = await Promise.allSettled([
        api(`/rpc-monitor/${chainId}`),
        staticUrls.length || !state.byId.get(chainId)?.rpcCount ? Promise.resolve(null) : api(`/endpoints/${chainId}`)
    ]);
    if (healthRes.status === 'fulfilled') { const d = healthRes.value; results = d.results || d.endpoints || (Array.isArray(d) ? d : []); }
    if (endpointsRes.status === 'fulfilled' && endpointsRes.value) staticUrls = usable(endpointsRes.value.rpc || []);
    if (openChainId !== chainId) return; // drawer moved on while fetching
    const working = results.filter(r => r.status === 'working' || r.ok === true);
    // List only reachable endpoints (failed ones are ignored). If nothing has
    // been health-checked yet, fall back to the registry list as untested.
    const listed = working.length ? working : (results.length ? [] : staticUrls.map(u => ({ url: u })));
    box.textContent = '';
    if (listed.length) {
        for (const r of listed.slice(0, 20)) {
            const ver = clientNameVersion(r.clientVersion);
            box.appendChild(el('div', { class: 'rpc-row' }, [
                el('span', { class: 'dot dot-ok' }),
                el('span', { class: 'rpc-host mono', text: safeHost(r.url) || r.url }),
                ver ? el('span', { class: 'rpc-meta muted', text: ver }) : null
            ]));
        }
    } else {
        box.appendChild(el('span', { class: 'muted', text: 'No reachable endpoints.' }));
    }
    // Block head: poll one live endpoint client-side every 5s. Try working
    // first, then any registry endpoint (browser CORS can differ from the
    // server's reachability).
    const candidates = [...new Set([...working.map(r => r.url), ...staticUrls])];
    if (candidates.length) startBlockHead(candidates, headCell); else headCell.textContent = '—';
}
async function loadLiveClients(chainId, box) {
    try {
        const d = await api(`/clients/${chainId}`);
        const clients = d.clients || [];
        if (!clients.length) { box.textContent = 'No client data yet.'; return; }
        box.textContent = ''; box.classList.remove('muted');
        for (const cl of clients) {
            const v = (cl.versions || [])[0]?.version;
            const allVers = (cl.versions || []).map(x => `${x.version}${x.nodeCount ? ` ×${x.nodeCount}` : ''}`).join(', ');
            box.appendChild(el('span', { class: 'client-pill', title: allVers }, [
                `${cl.name}${v ? ' ' : ''}`,
                v ? el('span', { class: 'client-ver', text: v }) : null,
                cl.nodeCount ? el('span', { class: 'client-count', text: ` ×${cl.nodeCount}` }) : null
            ]));
        }
    } catch { box.textContent = '—'; }
}

// ─── client-side block-head polling (one endpoint, every 5s) ───
let blockHeadTimer = null;
let blockHeadToken = 0;
function stopBlockHead() { if (blockHeadTimer) { clearInterval(blockHeadTimer); blockHeadTimer = null; } }
async function rpcBlockNumber(url) {
    try {
        const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }) });
        if (!res.ok) return null;
        const d = await res.json();
        const n = typeof d.result === 'string' ? parseInt(d.result, 16) : null;
        return Number.isFinite(n) ? n : null;
    } catch { return null; }
}
function startBlockHead(urls, cell) {
    stopBlockHead();
    const token = ++blockHeadToken;
    let liveUrl = null;
    const poll = async () => {
        for (const u of (liveUrl ? [liveUrl, ...urls] : urls)) {
            const n = await rpcBlockNumber(u);
            if (token !== blockHeadToken) return;         // drawer changed/closed
            if (n != null) { liveUrl = u; cell.textContent = `#${n.toLocaleString()}`; cell.title = safeHost(u) || u; return; }
        }
        if (token === blockHeadToken && !liveUrl) cell.textContent = '—';
    };
    poll();
    blockHeadTimer = setInterval(poll, 5000);
}
