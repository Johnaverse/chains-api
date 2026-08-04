// ─────────────────────────────────────────────────────────────────────────
// Chains — blockchain network analytics dashboard.
//
// Views: Overview (cross-cutting joins), Networks (registry table),
// Relationships (lazy 3D graph), Incidents, Providers, Forum.
//
// Data sources:
//   • chains-api /summary — slim bulk registry (ETag + localStorage SWR,
//     falls back to /export then the checked-in snapshot)
//   • chains-api /stats, /health, /validate — headline counts, source
//     freshness, cross-source data conflicts
//   • chains-status-news — incidents over REST backfill + WebSocket
//   • chains-forum-news — governance/forum posts over REST + WebSocket
//
// A NOTE ON HONESTY, because it constrains the whole render layer:
// this backend persists NO time series. Every store is replace-in-place —
// there is no TVS history, no price history, no uptime window, and
// RpcEndpointResult.latencyMs is permanently null. So this dashboard shows
// current state and cross-sectional structure only. There are no sparklines,
// no deltas and no trend lines anywhere, and the event histograms are
// explicitly labelled as counts of retained feed events rather than as
// metric trends.
// ─────────────────────────────────────────────────────────────────────────

const SAME_ORIGIN_API =
    location.port === '3000' || location.hostname === 'chains-api.johnaverse.cc';
const API_BASE = SAME_ORIGIN_API ? '' : 'https://chains-api.johnaverse.cc';
const STATUS_NEWS_BASE = 'https://chains-status-news.johnaverse.cc';
const FORUM_NEWS_BASE = 'https://chains-forum-news.johnaverse.cc';
// chains-news: the third feed (ecosystem news). Kept in lock-step with
// DASHBOARD_FEED_ORIGINS in src/http/app.js, which allow-lists it for the /ui
// mirror's CSP.
const NEWS_BASE = 'https://chains-news.johnaverse.cc';

const ALL_SOURCES = ['chains', 'chainlist', 'theGraph', 'slip44', 'l2beat'];
const SOURCE_LABELS = {
    chains: 'Chain ID Network', chainlist: 'Chainlist', theGraph: 'The Graph',
    slip44: 'SLIP-0044', l2beat: 'L2BEAT'
};

// ── One network taxonomy, used everywhere ──
// The old UI mixed environment (mainnet/testnet) with orthogonal tags (L2,
// Beacon, ZK) in a single column, so the column could not be scanned and the
// node colours disagreed with the table. These four groups are mutually
// exclusive and drive the type colour, the table column, the filter chips and
// the graph legend from one definition.
//
// Only THREE categorical hues plus neutral gray: four hues cannot clear
// all-pairs colour-vision separation, and the 3D graph puts any two node
// colours side by side. See the palette note in style.css.
const NET_CLASSES = {
    mainnet: { key: 'mainnet', label: 'Mainnet L1', dot: 'dot-mainnet', cssVar: '--cat-1' },
    l2: { key: 'l2', label: 'L2 / rollup', dot: 'dot-l2', cssVar: '--cat-2' },
    testnet: { key: 'testnet', label: 'Testnet', dot: 'dot-testnet', cssVar: '--cat-3' },
    other: { key: 'other', label: 'Other', dot: 'dot-other', cssVar: '--cat-0' }
};
// Three real groups. `other` stays defined as the fallback colour for a node
// whose class can't be resolved, but nothing is classified into it — which also
// means the type scale uses exactly the three validated categorical hues.
const NET_CLASS_ORDER = ['mainnet', 'l2', 'testnet'];

// Environment wins over the L2 tag: an L2 testnet is a testnet. That keeps the
// groups disjoint and makes "Testnet" mean the same thing in every surface.
//
// Beacon is deliberately NOT a type here. It is an orthogonal capability tag —
// Ethereum Mainnet (chain 1) carries it, and ranking it first typed the single
// most important L1 in the registry as "Other". It shows up as a class tag on
// the name instead, alongside ZK/Validium/Optimium.
function netClass(c) {
    const tags = c.tags || [];
    if (tags.includes('Testnet')) return NET_CLASSES.testnet;
    if (tags.includes('L2')) return NET_CLASSES.l2;
    return NET_CLASSES.mainnet;
}
// Class tags shown as a sub-line on the network name (not in the Type column).
function classTags(c) {
    return (c.tags || []).filter(t => t !== 'Testnet');
}

const state = {
    chains: [], byId: new Map(), rel: new Map(),
    l2beat: new Map(), l2beatProjects: [], l2beatMeta: null,
    statusPagesByChain: new Map(),
    lastUpdated: null,
    stats: null, health: null, validate: null,
    // chainId → array of OPEN incidents affecting it (operator + provider fan-out)
    openByChain: new Map()
};

// ─── DOM helpers ─────────────────────────────────────────────────────────
function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (v === null || v === undefined) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v);
    }
    for (const c of [].concat(children)) {
        if (c == null) continue;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
}
function byId(id) { return document.getElementById(id); }
function clear(node) { if (node) node.textContent = ''; }
// One place decides "is this a phone-sized viewport", matched to the CSS
// breakpoint so JS and CSS never disagree about the layout in force.
function isNarrow() { return window.matchMedia('(max-width: 760px)').matches; }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// ─── formatting ──────────────────────────────────────────────────────────
const fmtUsd = n => Viz.fmtUsd(n);
const fmtNum = n => Viz.fmtNum(n);

function fmtDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return null;
    const m = Math.round(ms / 60000);
    if (m < 1) return 'under a minute';
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${m % 60}m`;
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
}
function fmtAge(seconds) {
    if (!Number.isFinite(seconds)) return '—';
    if (seconds < 90) return `${Math.round(seconds)}s ago`;
    const m = seconds / 60;
    if (m < 90) return `${Math.round(m)}m ago`;
    const h = m / 60;
    if (h < 36) return `${Math.round(h)}h ago`;
    return `${Math.round(h / 24)}d ago`;
}
function relTime(iso) {
    const t = Date.parse(iso || '');
    if (Number.isNaN(t)) return '';
    return fmtAge(Math.max(0, (Date.now() - t) / 1000));
}
function fmtDateTime(ms) {
    return ms != null && !Number.isNaN(ms)
        ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
        : null;
}
function safeHost(url) {
    try {
        const u = new URL(url);
        return (u.protocol === 'http:' || u.protocol === 'https:') ? u.host : null;
    } catch { return null; }
}
function dayKey(ms) {
    return ms != null && !Number.isNaN(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
}

// A colored dot + text label. Type identity is never carried by text colour —
// a light categorical hue is illegible as text on either surface.
function typeTag(cls) {
    return el('span', { class: 'tag' }, [
        el('span', { class: `tag-dot ${cls.dot}` }), cls.label
    ]);
}


// A table cell that also works in the stacked mobile card layout: `data-label`
// becomes the field name shown beside the value, and cells with no value are
// dropped there rather than rendering "TVS —" on every card.
function td(label, children, { num = false, primary = false, empty = false, cls = '' } = {}) {
    const classes = [num ? 'num' : '', primary ? 'cell-primary' : '', empty ? 'is-empty' : '', cls]
        .filter(Boolean).join(' ');
    return el('td', {
        class: classes || null,
        'data-label': primary ? null : label
    }, children);
}

// ─── fetch helpers ───────────────────────────────────────────────────────
async function api(path, { timeoutMs = 25000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(`${API_BASE}${path}`, {
            headers: { accept: 'application/json' }, signal: ctrl.signal
        });
        if (!res.ok) throw new Error(`${path} → ${res.status}`);
        return await res.json();
    } finally { clearTimeout(timer); }
}

// POST helper for the assistant. Non-2xx responses still carry a useful JSON
// body ({error}), so return status + body and let callers branch.
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
    } finally { clearTimeout(timer); }
}

// ─────────────────────────────── bootstrap ───────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    initTabs();
    initSearch();
    initGraphControls();
    initDrawer();
    initAssistant();
    initIncidentControls();
    initProviderControls();
    initOverviewControls();
    initNewsControls();
    initChainsTable();
    initAppbarHeight();
    initResizeHandling();
    byId('loadRetryBtn')?.addEventListener('click', () => loadBulk());
    applyUrlState();

    // The live feed must not wait on the bulk load or the tab looks stuck.
    connectStatusFeed();
    loadStatsLine();
    loadBulk();
    loadDiagnostics();
    window.addEventListener('popstate', applyUrlState);
});

// ─── theme ───────────────────────────────────────────────────────────────
// Charts read their colours from CSS custom properties at render time, so a
// theme flip only needs a re-render — no palette duplication in JS.
function initTheme() {
    byId('themeToggle')?.addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme')
            || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
        const next = current === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        try { localStorage.setItem('chains:theme', next); } catch { /* best effort */ }
        rerenderCharts();
        if (myGraph) myGraph.backgroundColor(Viz.cssVar('--page'));
    });
}

function initResizeHandling() {
    const onResize = debounce(() => rerenderCharts(), 180);
    window.addEventListener('resize', onResize);

    // Backgrounding the browser tab should also stop the WebGL loop — browsers
    // throttle rAF for hidden tabs but do not guarantee it stops.
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) pauseGraph();
        else if (activeView === 'graph') resumeGraph();
    });
}

// Re-render every chart on the active view. Charts are laid out against their
// container width and read theme colours at render time, so resize and theme
// changes both just need this.
function rerenderCharts() {
    if (activeView === 'overview') renderOverview({ force: true });
    else if (activeView === 'incidents') renderIncidents();
    else if (activeView === 'providers') renderProviders();
    else if (activeView === 'news') renderNewsSources();
    // The forum list caps posts per group by breakpoint, so it re-renders too.
    else if (activeView === 'forum') { renderForumTreemap(); renderForumList(); }
}

// ─── headline counts ─────────────────────────────────────────────────────
async function loadStatsLine() {
    try {
        state.stats = await api('/stats');
        renderAppbarMeta();
        if (activeView === 'overview') renderOverview();
    } catch { /* the bulk load still populates counts */ }
}

// /health and the validation report power the two credibility panels on
// Overview. They are the most trustworthy thing this API exposes and the old
// dashboard never called either one.
//
// The counts come from /metrics rather than /validate: the panel renders 17
// numbers, and /validate ships 184 KB to deliver them (92 KB of `allErrors` +
// 92 KB of `errorsByRule` we never read). /metrics exposes the same figures as
// gauges in 3.4 KB — a ~54x smaller parse, which matters on a phone. /validate
// stays as the fallback if the gauges are missing.
async function loadDiagnostics() {
    const [health, metrics] = await Promise.allSettled([api('/health'), apiText('/metrics')]);
    if (health.status === 'fulfilled') state.health = health.value;

    let validation = metrics.status === 'fulfilled' ? parseValidationMetrics(metrics.value) : null;
    if (!validation) {
        try { validation = await api('/validate'); } catch { /* panel shows nothing */ }
    }
    if (validation) state.validate = validation;

    renderAppbarMeta();
    if (activeView === 'overview') { renderDataQuality(); renderFreshness(); renderOverviewStats(); }
}

async function apiText(path, { timeoutMs = 15000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(`${API_BASE}${path}`, { headers: { accept: 'text/plain' }, signal: ctrl.signal });
        if (!res.ok) throw new Error(`${path} → ${res.status}`);
        return await res.text();
    } finally { clearTimeout(timer); }
}

// Pull `chains_api_validation_errors{rule="ruleN"} <count>` out of the
// Prometheus exposition and rebuild the shape renderDataQuality already reads.
// Returns null when the gauges are absent (they only appear once the server has
// run validation), so the caller can fall back to /validate.
function parseValidationMetrics(text) {
    if (typeof text !== 'string') return null;
    const summary = {};
    let total = 0;
    const re = /^chains_api_validation_errors\{rule="(rule\d+)"\}\s+(\d+(?:\.\d+)?)$/gm;
    let m;
    while ((m = re.exec(text)) !== null) {
        const n = Number(m[2]);
        if (!Number.isFinite(n)) continue;
        summary[m[1]] = n;
        total += n;
    }
    if (!Object.keys(summary).length) return null;
    return { totalErrors: total, summary, source: 'metrics' };
}

function renderAppbarMeta() {
    const s = state.stats;
    const chainsEl = byId('metaChains');
    const asOfEl = byId('metaAsOf');
    if (chainsEl) {
        const n = s?.totalChains ?? state.chains.length;
        chainsEl.textContent = n ? `${fmtNum(n)} networks` : '—';
    }
    if (asOfEl) {
        const parts = [];
        if (state.lastUpdated) parts.push(`registry ${relTime(state.lastUpdated)}`);
        if (state.l2beatMeta?.fetchedAt) parts.push(`L2BEAT ${relTime(state.l2beatMeta.fetchedAt)}`);
        asOfEl.textContent = parts.length ? parts.join(' · ') : 'loading…';
        asOfEl.title = state.lastUpdated
            ? `Registry built ${fmtDateTime(Date.parse(state.lastUpdated))}`
            : '';
    }
}

// ─── bulk load: /summary with ETag + localStorage SWR ────────────────────
const SUMMARY_LS_KEY = 'chains:summary:v2';
const SUMMARY_TTL_MS = 24 * 60 * 60 * 1000;

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
    try {
        localStorage.setItem(SUMMARY_LS_KEY, JSON.stringify({
            savedAt: Date.now(), etag: etag || null, payload
        }));
    } catch { /* quota / private mode — cache is best-effort */ }
}

async function loadBulk() {
    hideLoadError();
    const cached = readCachedSummary();
    if (cached) applyBulk(cached.payload);

    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const headers = { accept: 'application/json' };
            if (cached?.etag) headers['if-none-match'] = cached.etag;
            const res = await fetch(`${API_BASE}/summary`, { headers, signal: AbortSignal.timeout(25000) });
            if (res.status === 304) { writeCachedSummary(cached.payload, cached.etag); return; }
            if (!res.ok) throw new Error(String(res.status));
            const payload = await res.json();
            writeCachedSummary(payload, res.headers.get('etag'));
            applyBulk(payload);
            return;
        } catch { if (attempt === 0) await new Promise(r => setTimeout(r, 1200)); }
    }
    try { applyBulk(await api('/export')); return; } catch { /* next fallback */ }
    try { applyBulk(await (await fetch('summary.json')).json()); return; } catch { /* fall through */ }
    if (!state.chains.length) showLoadError();
}

// Accepts both /summary ({chains, l2beat}) and /export ({data:{indexed:{all}}}).
let statusPagesLoaded = false;
function applyBulk(payload) {
    const data = payload.data ?? payload;
    state.chains = data.chains ?? data.indexed?.all ?? [];
    state.lastUpdated = data.lastUpdated ?? null;
    state.byId = new Map(state.chains.map(c => [c.chainId, c]));
    state.l2beatMeta = data.l2beat
        ? {
            source: data.l2beat.source,
            fetchedAt: data.l2beat.fetchedAt ?? null,
            count: (data.l2beat.projects || []).length
        }
        : null;
    state.l2beatProjects = data.l2beat?.projects ?? [];
    state.l2beat = new Map();
    for (const p of state.l2beatProjects) if (p.chainId != null) state.l2beat.set(p.chainId, p);
    state.rel = new Map();

    buildRelations();
    buildOpenIncidentIndex();
    graphDirty = true;
    if (activeView === 'graph') ensureGraphView();

    renderAppbarMeta();
    renderChainFilters();
    // Building 100 table rows costs ~30 ms on a throttled phone. Only do it if
    // the reader is actually on Networks; otherwise mark it stale and let
    // switchView() build it on arrival.
    if (activeView === 'networks') renderChainsTable();
    else chainsTableStale = true;
    if (activeView === 'overview') renderOverview();

    if (!statusPagesLoaded) { statusPagesLoaded = true; loadStatusPages(); }
    applyUrlState();
}

function showLoadError() {
    byId('loadErrorBanner')?.classList.remove('hidden');
    const o = byId('loadingOverlay');
    if (o) {
        o.querySelector('.spinner')?.classList.add('hidden');
        const p = o.querySelector('p');
        if (p) p.textContent = 'Could not load network data.';
        const sub = o.querySelector('.loading-sub');
        if (sub) sub.textContent = 'Check your connection, or that the API is reachable.';
    }
}
function hideLoadError() { byId('loadErrorBanner')?.classList.add('hidden'); }

// ─── relations ───────────────────────────────────────────────────────────
function relEntry(id) {
    if (!state.rel.has(id)) {
        state.rel.set(id, { l1Parent: null, mainnet: null, l2Children: [], testnetChildren: [] });
    }
    return state.rel.get(id);
}
// /summary carries both directions of every edge (l2Of/parentOf and
// testnetOf/mainnetOf), so fold them into one entry per chain.
function buildRelations() {
    for (const c of state.chains) {
        for (const r of c.relations ?? []) {
            if (r.chainId == null) continue;
            if (r.kind === 'l2Of') {
                relEntry(c.chainId).l1Parent = r.chainId;
                relEntry(r.chainId).l2Children.push(c.chainId);
            } else if (r.kind === 'parentOf') {
                relEntry(r.chainId).l1Parent = c.chainId;
                relEntry(c.chainId).l2Children.push(r.chainId);
            } else if (r.kind === 'testnetOf') {
                relEntry(c.chainId).mainnet = r.chainId;
                relEntry(r.chainId).testnetChildren.push(c.chainId);
            } else if (r.kind === 'mainnetOf') {
                relEntry(r.chainId).mainnet = c.chainId;
                relEntry(c.chainId).testnetChildren.push(r.chainId);
            }
        }
    }
    for (const e of state.rel.values()) {
        e.l2Children = [...new Set(e.l2Children)];
        e.testnetChildren = [...new Set(e.testnetChildren)];
    }
}

// ─── app-bar height sync ─────────────────────────────────────────────────
// The bar is fixed and content pads by var(--appbar-h). Measuring it keeps
// content clear of the bar when it wraps to extra rows on narrow screens.
function initAppbarHeight() {
    const bar = byId('appbar');
    if (!bar) return;
    const sync = () => document.documentElement.style.setProperty('--appbar-h', `${bar.offsetHeight}px`);
    sync();
    window.addEventListener('resize', sync);
    if ('ResizeObserver' in window) new ResizeObserver(sync).observe(bar);
}

// ─────────────────────────────── tabs / routing ──────────────────────────
const VIEWS = ['overview', 'networks', 'graph', 'incidents', 'providers', 'news', 'forum'];
const DEFAULT_VIEW = 'overview';
let activeView = DEFAULT_VIEW;
let searchQuery = '';
let openChainId = null;

function initTabs() {
    const tabs = [...document.querySelectorAll('#tabs .tab')];
    tabs.forEach(btn => btn.addEventListener('click', () => switchView(btn.dataset.view)));
    byId('tabs')?.addEventListener('keydown', e => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const i = tabs.findIndex(t => t.dataset.view === activeView);
        const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
        next.focus();
        switchView(next.dataset.view);
    });
}

function switchView(view, opts = {}) {
    if (!VIEWS.includes(view)) view = DEFAULT_VIEW;
    activeView = view;
    document.querySelectorAll('#tabs .tab').forEach(b =>
        b.setAttribute('aria-selected', String(b.dataset.view === view)));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    byId(`view-${view}`)?.classList.add('active');
    document.body.classList.toggle('graph-active', view === 'graph');

    if (view === 'networks' && chainsTableStale) { chainsTableStale = false; renderChainsTable(); }
    if (view === 'graph') ensureGraphView();
    else pauseGraph();   // stop the WebGL loop the moment the graph is hidden
    if (view === 'forum') ensureForumView();
    if (view === 'news') ensureNewsView();
    if (view === 'overview') renderOverview();
    if (view === 'incidents') renderIncidents();
    if (view === 'providers') renderProviders();

    updateSearchPlaceholder();
    applySearch();
    if (!opts.fromUrl) updateUrl({ push: true });
}

function updateSearchPlaceholder() {
    const input = byId('searchInput');
    if (!input) return;
    input.placeholder =
        activeView === 'networks' ? 'Filter networks — id or name…'
            : activeView === 'incidents' ? 'Filter incidents — network or title…'
                : activeView === 'providers' ? 'Filter provider incidents — provider, chain or title…'
                    : activeView === 'news' ? 'Filter news — title, source or network…'
                : activeView === 'forum' ? 'Filter posts — network, forum or title…'
                        : 'Search networks — id or name…';
}

function applySearch() {
    if (activeView === 'networks') { chainShown = null; renderChainsTable(); }
    else if (activeView === 'incidents') renderIncidentList();
    else if (activeView === 'providers') renderProviderList();
    else if (activeView === 'news') renderNewsList();
    else if (activeView === 'forum') { renderForumTreemap(); renderForumList(); }
}

function updateUrl({ push = false } = {}) {
    const u = new URL(location.href);
    const set = (k, v) => { if (v == null || v === '') u.searchParams.delete(k); else u.searchParams.set(k, v); };
    set('view', activeView === DEFAULT_VIEW ? null : activeView);
    set('q', searchQuery || null);
    set('chain', openChainId);
    history[push ? 'pushState' : 'replaceState'](null, '', u);
}

function applyUrlState() {
    const params = new URLSearchParams(location.search);
    const q = params.get('q') || '';
    searchQuery = q.trim().toLowerCase();
    const input = byId('searchInput');
    if (input && input.value !== q) input.value = q;
    switchView(params.get('view') || DEFAULT_VIEW, { fromUrl: true });

    const chain = params.get('chain');
    if (chain && state.byId.has(Number(chain))) openChainDetail(Number(chain), { fromUrl: true });
    else closeDrawer({ fromUrl: true });
}

// ─────────────────────────────── global search ───────────────────────────
function chainMatchesQuery(c, q) {
    return String(c.chainId).includes(q)
        || c.name?.toLowerCase().includes(q)
        || c.shortName?.toLowerCase().includes(q)
        || (c.aliases || []).some(a => a.includes(q));
}

function initSearch() {
    const input = byId('searchInput');
    const dd = byId('searchDropdown');
    if (!input || !dd) return;
    let activeIdx = -1;

    const renderDropdown = debounce(q => {
        if (!q) { dd.classList.add('hidden'); return; }
        const matches = state.chains.filter(c => chainMatchesQuery(c, q)).sort((a, b) => {
            // Dead chains sink; then a name or alias starting with the query
            // outranks a mid-string hit ("optimism" → OP Mainnet first).
            const ad = a.status === 'deprecated', bd = b.status === 'deprecated';
            if (ad !== bd) return ad ? 1 : -1;
            const hit = c => (c.name || '').toLowerCase().startsWith(q)
                || (c.aliases || []).some(t => t.startsWith(q));
            const as = hit(a), bs = hit(b);
            if (as !== bs) return as ? -1 : 1;
            return (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
        }).slice(0, 40);

        clear(dd);
        activeIdx = -1;
        if (!matches.length) {
            dd.appendChild(el('div', { class: 'dropdown-empty', text: 'No networks found.' }));
        }
        for (const c of matches) {
            const cls = netClass(c);
            const open = state.openByChain.get(c.chainId);
            dd.appendChild(el('div', {
                class: 'dropdown-item', role: 'option', 'data-id': c.chainId,
                onclick: () => pick(c.chainId)
            }, [
                el('span', { class: `tag-dot ${cls.dot}` }),
                el('div', { class: 'dropdown-info' }, [
                    el('div', { class: 'dropdown-name', text: c.name || `Chain ${c.chainId}` }),
                    el('div', {
                        class: 'dropdown-meta',
                        text: [`ID ${c.chainId}`, cls.label,
                            c.status === 'deprecated' ? 'deprecated' : null,
                            open?.length ? 'open incident' : null].filter(Boolean).join(' · ')
                    })
                ])
            ]));
        }
        dd.classList.remove('hidden');
    }, 140);

    const debouncedApplySearch = debounce(applySearch, 150);
    function onInput(raw) {
        searchQuery = raw.trim().toLowerCase();
        updateUrl();
        debouncedApplySearch();
        renderDropdown(searchQuery);
    }
    function pick(id) {
        dd.classList.add('hidden');
        openChainDetail(id);
        if (activeView === 'graph') focusNodeById(id);
    }
    globalThis.pickChain = pick;

    input.addEventListener('input', e => onInput(e.target.value));
    input.addEventListener('keydown', e => {
        const items = dd.querySelectorAll('.dropdown-item');
        if (e.key === 'ArrowDown' && items.length) {
            e.preventDefault(); activeIdx = Math.min(activeIdx + 1, items.length - 1); mark(items);
        } else if (e.key === 'ArrowUp' && items.length) {
            e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); mark(items);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const t = items[activeIdx] || items[0];
            if (t) pick(Number(t.dataset.id));
        } else if (e.key === 'Escape') { dd.classList.add('hidden'); input.blur(); }
    });
    function mark(items) {
        items.forEach((it, i) => it.classList.toggle('active', i === activeIdx));
        items[activeIdx]?.scrollIntoView({ block: 'nearest' });
    }
    document.addEventListener('click', e => {
        if (!e.target.closest('.search-box')) dd.classList.add('hidden');
    });
    document.addEventListener('keydown', e => {
        const tag = document.activeElement?.tagName;
        if (e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA') { e.preventDefault(); input.focus(); }
    });
}

// ─── status pages (drawer links) ─────────────────────────────────────────
async function loadStatusPages() {
    try {
        const d = await api('/status-pages');
        for (const sp of d.statusPages || []) {
            for (const id of sp.chainIds || []) {
                state.statusPagesByChain.set(id, { id: sp.id, name: sp.name, url: sp.url });
            }
        }
    } catch { /* the drawer simply omits the status-page link */ }
}

// ═════════════════════════════════════════════════════════════════════════
// Incidents (chains-status-news: REST backfill + WebSocket)
// ═════════════════════════════════════════════════════════════════════════

// The feed emits a normalized lifecycle `status` on every event. Map the wire
// vocabulary to display labels; never re-derive it from the summary HTML.
const STATUS_LABEL = {
    investigating: 'Investigating', identified: 'Identified', monitoring: 'Monitoring',
    resolved: 'Resolved', maintenance_scheduled: 'Scheduled',
    maintenance_in_progress: 'In progress', maintenance_completed: 'Completed',
    operational: 'Operational', degraded: 'Degraded',
    partial_outage: 'Partial outage', major_outage: 'Major outage'
};
const SCHEDULED_STATUSES = new Set([
    'maintenance_scheduled', 'maintenance_in_progress', 'maintenance_completed'
]);

// LLM severity → the reserved status scale. Only these three values are ever
// emitted by the feed; anything else falls through to "none" and the card says
// the event is unclassified rather than inventing a level.
const SEVERITY_RANK = { critical: 3, major: 2, minor: 1 };
const SEVERITY_META = {
    critical: { key: 'critical', label: 'Critical', cssVar: '--critical' },
    major: { key: 'major', label: 'Major', cssVar: '--serious' },
    minor: { key: 'minor', label: 'Minor', cssVar: '--warn' },
    none: { key: 'none', label: 'Not classified', cssVar: '--cat-0' }
};

const incidents = {
    items: [], byKey: new Map(), ws: null, retries: 0,
    groupBy: 'flat', dayFilter: null, category: 'all', severity: 'all', shown: null,
    backfilled: false, backfillInFlight: false,
    // Two-phase enrichment: most events carry `enrichment` inline on the REST
    // backfill, but live WS `status.enrichment` frames arrive separately and
    // are keyed by raw eventId. eventToKey resolves an eventId to its incident;
    // enrichPending stashes frames that beat their item.
    eventToKey: new Map(), enrichByKey: new Map(), enrichPending: new Map(), enrichTimer: null
};
const providers = { filter: 'all', dayFilter: null, shown: null };
// Rendering every retained event made Providers ~48 phone-screens tall and
// Incidents ~28. Page them; the counts above still state the true total.
const FEED_PAGE = 25;
function feedPageSize() { return isNarrow() ? 10 : FEED_PAGE; }

function feedMoreButton(total, shown, onMore) {
    return el('div', { class: 'table-foot' }, [
        el('button', {
            class: 'btn', type: 'button',
            text: `Show more — ${fmtNum(total - shown)} remaining`,
            onclick: onMore
        })
    ]);
}

// eventToKey/enrichPending grow per raw event id, so cap them for long-lived
// tabs. Maps keep insertion order — evict oldest.
const MAX_EVENT_KEYS = 5000;
const MAX_ENRICH_PENDING = 500;
function capMap(map, max) { while (map.size > max) map.delete(map.keys().next().value); }

function incidentKey(ev) {
    const sp = ev.statusPage?.id || (ev.chains?.[0]?.chainId ?? 'unknown');
    return `${sp}|${(ev.title || '').toLowerCase().trim()}`;
}
function eventTimeMs(ev) {
    const t = Date.parse(ev.publishedAt || ev.updatedAt || '');
    return Number.isNaN(t) ? null : t;
}
function classifyKind(ev) {
    if (SCHEDULED_STATUSES.has(ev.status)) return 'scheduled';
    return 'incident';
}

// A status page is one of three kinds: a chain operator, a coin, or a
// commercial RPC provider. Providers get their own tab because one provider
// incident fans out across many chains.
function pageKind(ev) {
    const k = ev.statusPage?.kind;
    return k === 'rpc-provider' ? 'provider' : k === 'coin' ? 'coin' : 'chain';
}

function incidentModel(ev) {
    const whenMs = eventTimeMs(ev);
    const kindOfPage = pageKind(ev);
    const chainIds = (ev.chains || []).map(c => c.chainId).filter(id => id != null);
    const primaryChain = ev.chains?.[0];
    const ongoingSince = Date.parse(ev.ongoingSince || '');

    return {
        key: incidentKey(ev),
        title: ev.title || '(untitled)',
        url: ev.url,
        whenMs,
        firstSeen: whenMs,
        lastSeen: whenMs,
        status: STATUS_LABEL[ev.status] || null,
        rawStatus: ev.status || null,
        ongoing: typeof ev.ongoing === 'boolean' ? ev.ongoing : null,
        // Authoritative start of an open incident. This is what makes an honest
        // duration possible; the previous implementation scraped timestamps out
        // of the summary HTML with a regex and showed the result as fact.
        ongoingSinceMs: Number.isNaN(ongoingSince) ? null : ongoingSince,
        kind: classifyKind(ev),
        pageKind: kindOfPage,
        urgency: ev.urgency || null,
        impact: ev.impact || null,
        // Client/version named by the operator, when they name one.
        software: Array.isArray(ev.software)
            ? ev.software.filter(Boolean).map(s => [s.client, s.version].filter(Boolean).join(' ')).filter(Boolean)
            : [],
        netName: primaryChain?.name || ev.statusPage?.name || ev.statusPage?.id || 'Unknown',
        chainId: primaryChain?.chainId ?? null,
        chainIds,
        spId: ev.statusPage?.id || (primaryChain?.chainId != null ? String(primaryChain.chainId) : 'unknown'),
        spName: ev.statusPage?.name || ev.statusPage?.id || 'Unknown source',
        isProvider: kindOfPage === 'provider',
        affectedComponents: Array.isArray(ev.affectedComponents) ? ev.affectedComponents : [],
        // Names the enrichment mentions but that could not be resolved to a
        // registry chain ID — shown as plain text, never as a link.
        affectedNames: []
    };
}

function addIncidents(events) {
    let changed = false;
    for (const ev of events) {
        const m = incidentModel(ev);
        if (ev.id) {
            incidents.eventToKey.set(ev.id, m.key);
            capMap(incidents.eventToKey, MAX_EVENT_KEYS);
            const early = incidents.enrichPending.get(ev.id);
            if (early) { incidents.enrichPending.delete(ev.id); applyEnrichment(m.key, early); }
        }
        // The REST backfill ships enrichment INLINE on most events. The old
        // dashboard only read WS enrichment frames, so several hundred existing
        // AI classifications were discarded on every page load.
        if (ev.enrichment) applyEnrichment(m.key, ev.enrichment);

        const existing = incidents.byKey.get(m.key);
        if (!existing) { incidents.byKey.set(m.key, m); changed = true; continue; }

        if (m.whenMs != null) {
            existing.firstSeen = Math.min(existing.firstSeen ?? m.whenMs, m.whenMs);
            existing.lastSeen = Math.max(existing.lastSeen ?? m.whenMs, m.whenMs);
            if (existing.whenMs == null || m.whenMs >= existing.whenMs) {
                // Newest event wins for current state.
                Object.assign(existing, {
                    whenMs: m.whenMs, status: m.status, rawStatus: m.rawStatus,
                    ongoing: m.ongoing, ongoingSinceMs: m.ongoingSinceMs,
                    url: m.url, kind: m.kind, urgency: m.urgency, impact: m.impact
                });
                if (m.chainIds.length) { existing.chainIds = m.chainIds; existing.chainId = m.chainId; }
                if (m.affectedComponents.length) existing.affectedComponents = m.affectedComponents;
                if (m.software.length) existing.software = m.software;
            }
        }
        changed = true;
    }
    if (!changed) return;
    incidents.items = [...incidents.byKey.values()].sort((a, b) => (b.whenMs || 0) - (a.whenMs || 0));
    scheduleIncidentRepaint();
}

// The WebSocket replays ~100 events on connect, one frame at a time. Repainting
// per frame ran buildOpenIncidentIndex + the stats/impact renders 100+ times on
// load (measured), all of it thrown away by the next frame. Coalesce into one
// repaint per animation frame batch.
let incidentRepaintTimer = null;
function scheduleIncidentRepaint() {
    if (incidentRepaintTimer) return;
    incidentRepaintTimer = setTimeout(() => {
        incidentRepaintTimer = null;
        buildOpenIncidentIndex();
        repaintIncidentSurfaces();
    }, 120);
}

function addEnrichment(enr) {
    const key = incidents.eventToKey.get(enr.eventId);
    if (!key) {
        incidents.enrichPending.set(enr.eventId, enr);
        capMap(incidents.enrichPending, MAX_ENRICH_PENDING);
        return;
    }
    if (applyEnrichment(key, enr)) scheduleEnrichmentRerender();
}

// Newest enrichment wins per incident (a later update can re-classify it). An
// older frame loses; equal/absent timestamps let the later arrival win so a
// re-classification is never dropped.
function applyEnrichment(key, enr) {
    const prev = incidents.enrichByKey.get(key);
    if (prev && (Date.parse(prev.createdAt) || 0) > (Date.parse(enr.createdAt) || 0)) return false;
    incidents.enrichByKey.set(key, enr);
    return true;
}
function scheduleEnrichmentRerender() {
    if (incidents.enrichTimer) return;
    incidents.enrichTimer = setTimeout(() => {
        incidents.enrichTimer = null;
        scheduleIncidentRepaint();
    }, 300);
}

function repaintIncidentSurfaces() {
    // The badge is always live — it is visible from every view.
    try { renderTabBadge(); } catch { /* non-critical */ }
    // Only repaint the view the user is actually looking at. Calendars,
    // histograms and lists are rebuilt from scratch, so painting two hidden
    // views on every WebSocket frame was pure waste; switchView() re-renders
    // a view when it becomes active.
    if (activeView === 'incidents') {
        try { renderIncidents(); } catch (err) { console.error('incident render failed', err); }
    }
    if (activeView === 'providers') {
        try { renderProviders(); } catch (err) { console.error('provider render failed', err); }
    }
    // Only the incident-dependent parts of Overview. Re-rendering the TVS
    // charts on every feed message would repaint charts whose data did not
    // change, which reads as a flash on refetch.
    if (activeView === 'overview') {
        try { renderOverviewStats(); renderImpact(); } catch (err) { console.error('overview render failed', err); }
    }
    if (activeView === 'networks') {
        try { renderChainsTable(); } catch (err) { console.error('table render failed', err); }
    }
    // Node colours depend on which chains have an open incident.
    if (graphEmphasizeIncidents && myGraph) applyGraphFilter();
}

function severityOf(it) {
    const enr = incidents.enrichByKey.get(it.key);
    const raw = enr?.severity ? String(enr.severity).toLowerCase() : null;
    return SEVERITY_META[raw] || SEVERITY_META.none;
}
function enrichmentOf(it) { return incidents.enrichByKey.get(it.key) || null; }

// An incident is open when the feed says so. Fall back to the status label only
// for older cached events that predate the `ongoing` flag.
function isOpen(it) {
    if (it.ongoing != null) return it.ongoing;
    return Boolean(it.status && !['resolved', 'completed', 'closed'].includes(it.status.toLowerCase()));
}

// Duration, stated for what it actually is:
//   • open incident with a start time → "open 3h 20m" (authoritative)
//   • otherwise → the span over which we OBSERVED updates, labelled as such
// Never a duration parsed out of prose.
function durationInfo(it) {
    if (isOpen(it) && it.ongoingSinceMs) {
        const d = fmtDuration(Date.now() - it.ongoingSinceMs);
        if (d) return { text: `open ${d}`, title: `Open since ${fmtDateTime(it.ongoingSinceMs)}` };
    }
    if (it.firstSeen != null && it.lastSeen != null && it.lastSeen > it.firstSeen) {
        const d = fmtDuration(it.lastSeen - it.firstSeen);
        if (d) return { text: `seen over ${d}`, title: 'Span between the first and last update this dashboard observed' };
    }
    return null;
}

// ── the cross-cutting join ──
// chainId → open incidents affecting it, from BOTH chain operator pages and
// RPC provider fan-out. This is what lets the Networks table, the Overview
// impact panel and the graph agree about who is currently affected.
function buildOpenIncidentIndex() {
    const map = new Map();
    for (const it of incidents.items) {
        if (!isOpen(it)) continue;
        for (const id of it.chainIds) {
            if (!map.has(id)) map.set(id, []);
            map.get(id).push(it);
        }
    }
    // Worst severity first so a table cell can show the most serious one.
    for (const arr of map.values()) {
        arr.sort((a, b) => (SEVERITY_RANK[severityOf(b).key] || 0) - (SEVERITY_RANK[severityOf(a).key] || 0));
    }
    state.openByChain = map;
}

function openIncidents() { return incidents.items.filter(isOpen); }

function renderTabBadge() {
    const badge = byId('tabBadgeIncidents');
    if (!badge) return;
    const n = incidents.items.filter(it => isOpen(it) && !it.isProvider).length;
    badge.textContent = n ? String(n) : '';
    badge.classList.toggle('hidden', !n);
    badge.title = n ? `${n} open chain incident${n === 1 ? '' : 's'}` : '';
}

// ─── feed transport ──────────────────────────────────────────────────────
function connectStatusFeed() {
    // The WS replay is capped server-side (~100 events), so full history always
    // comes from the REST backfill; the socket only streams live updates.
    statusFeedBackfill();
    setFeedLive(false);
    const wsUrl = `${STATUS_NEWS_BASE.replace(/^http/, 'ws')}/ws?replay=100`;
    let ws;
    try { ws = new WebSocket(wsUrl); } catch { return; }
    incidents.ws = ws;
    ws.onopen = () => { incidents.retries = 0; setFeedLive(true); statusFeedBackfill(); };
    ws.onmessage = ev => {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'status.item' && m.item) addIncidents([m.item]);
        else if (m.type === 'status.enrichment' && m.eventId) addEnrichment(m);
    };
    ws.onerror = () => { try { ws.close(); } catch { /* noop */ } };
    ws.onclose = () => {
        incidents.ws = null;
        setFeedLive(false);
        if (incidents.retries < 6) {
            const delay = Math.min(1000 * 2 ** incidents.retries, 20000);
            incidents.retries++;
            setTimeout(connectStatusFeed, delay);
        }
    };
}
function setFeedLive(live) { setLiveDot(['incidentsMeta', 'providersMeta', 'impactMeta'], live); }

function setLiveDot(ids, live) {
    for (const id of [].concat(ids)) {
        const e = byId(id);
        if (!e) continue;
        e.className = 'pill-meta live-pill';
        clear(e);
        e.appendChild(el('span', {
            class: `live-dot ${live ? 'on' : 'off'}`,
            title: live ? 'Live — receiving real-time updates' : 'Disconnected from the live feed'
        }));
        e.appendChild(document.createTextNode(live ? 'live' : 'offline'));
    }
}

async function statusFeedBackfill() {
    if (incidents.backfilled || incidents.backfillInFlight) return;
    incidents.backfillInFlight = true;
    try {
        const res = await fetch(`${STATUS_NEWS_BASE}/events?limit=500`, {
            headers: { accept: 'application/json' }
        });
        if (!res.ok) throw new Error(String(res.status));
        const d = await res.json();
        addIncidents(d.events || d.items || []);
        incidents.backfilled = true;
    } catch {
        if (!incidents.items.length) {
            for (const id of ['incidentsList', 'providersList']) {
                const l = byId(id);
                if (l) {
                    clear(l);
                    l.appendChild(el('div', {
                        class: 'feed-empty',
                        text: 'Live status feed unavailable (chains-status-news).'
                    }));
                }
            }
        }
    } finally {
        incidents.backfillInFlight = false;
    }
}

// ═════════════════════════════════════════════════════════════════════════
// Overview — the cross-cutting view. Everything here is a current reading;
// nothing implies a trend, because the API stores no history.
// ═════════════════════════════════════════════════════════════════════════

let impactScope = 'all';

function initOverviewControls() {
    document.querySelectorAll('#impactScope .chip').forEach(chip => {
        chip.addEventListener('click', () => {
            impactScope = chip.dataset.scope;
            document.querySelectorAll('#impactScope .chip').forEach(c =>
                c.setAttribute('aria-pressed', String(c === chip)));
            renderImpact();
        });
    });
}

function renderOverview({ force = false } = {}) {
    renderOverviewStats();
    renderImpact();
    renderTvsCharts({ force });
    renderConcentration({ force });
    renderDataQuality();
    renderFreshness();
    const cc = byId('ovChainCount');
    if (cc) cc.textContent = state.chains.length ? fmtNum(state.chains.length) : 'the';
}

function statTile({ label, value, sub, tone, meter, hero, hint }) {
    const tile = el('div', { class: `stat-tile${tone ? ` tone-${tone}` : ''}${hero ? ' is-hero' : ''}` });
    const lab = el('div', { class: 'stat-label' }, [label]);
    if (hint) {
        lab.appendChild(el('span', { class: 'info-dot', text: 'i', title: hint, 'aria-label': hint, role: 'img' }));
    }
    tile.appendChild(lab);
    tile.appendChild(el('div', { class: 'stat-value', text: value }));
    if (sub) tile.appendChild(el('div', { class: 'stat-sub', text: sub }));
    if (meter != null && Number.isFinite(meter)) {
        const track = el('div', { class: 'meter' }, [el('div', { class: 'meter-fill' })]);
        track.firstChild.style.width = `${Math.max(0, Math.min(100, meter))}%`;
        tile.appendChild(track);
    }
    return tile;
}

function renderOverviewStats() {
    const wrap = byId('overviewStats');
    if (!wrap) return;
    const s = state.stats || {};
    const open = openIncidents();
    const openChainSide = open.filter(it => !it.isProvider).length;
    const openProviderSide = open.filter(it => it.isProvider).length;
    const affected = state.openByChain.size;
    const rpcPct = s.rpc && s.rpc.healthPercent != null ? Number(s.rpc.healthPercent) : null;
    const tvs = totalTvs();

    // RPC health thresholds describe endpoint reachability from the monitor's
    // vantage point, which is genuinely low for public endpoint lists.
    const rpcTone = rpcPct == null ? '' : rpcPct >= 80 ? 'good' : rpcPct >= 50 ? 'warn' : 'critical';

    const tiles = [
        // Exactly one hero figure per view: for an operational overview the
        // headline is how much is broken right now.
        statTile({
            label: 'Open incidents', value: fmtNum(open.length), hero: true,
            sub: `${fmtNum(openChainSide)} chain · ${fmtNum(openProviderSide)} provider`,
            tone: open.length === 0 ? 'good' : open.length > 20 ? 'critical' : 'warn',
            hint: 'Incidents the feed still reports as unresolved, across chain operator, coin and RPC-provider status pages.'
        }),
        statTile({
            label: 'Networks affected now', value: fmtNum(affected),
            sub: affected ? `of ${fmtNum(state.chains.length)} tracked` : 'no chain currently named',
            tone: affected === 0 ? 'good' : affected > 25 ? 'critical' : 'warn',
            hint: 'Distinct chain IDs named by at least one open incident, including RPC-provider fan-out.'
        }),
        statTile({
            label: 'Networks', value: fmtNum(s.totalChains ?? (state.chains.length || null)),
            sub: s.activeChains != null
                ? `${fmtNum(s.activeChains)} active · ${fmtNum(s.deprecatedChains)} deprecated`
                : '',
            hint: 'Chains in the merged registry across all five upstream sources.'
        }),
        statTile({
            label: 'RPC endpoint health', value: rpcPct != null ? `${rpcPct}%` : '—',
            sub: s.rpc ? `${fmtNum(s.rpc.working)} of ${fmtNum(s.rpc.tested)} reachable` : '',
            tone: rpcTone, meter: rpcPct,
            hint: 'Share of probed public RPC endpoints that answered. Public endpoint lists contain many dead URLs, so a low figure is normal and is a data-quality signal, not an outage.'
        }),
        statTile({
            label: 'L2 value secured', value: tvs ? fmtUsd(tvs) : '—',
            sub: state.l2beatProjects.length
                ? `${fmtNum(state.l2beatProjects.length)} L2BEAT projects`
                : '',
            hint: 'Total value secured across all L2BEAT-classified projects, as of the last L2BEAT fetch. Point-in-time only — no history is stored.'
        }),
        statTile({
            label: 'Data conflicts', value: state.validate ? fmtNum(state.validate.totalErrors) : '—',
            sub: state.validate ? 'across 17 validation rules' : '',
            tone: !state.validate ? '' : state.validate.totalErrors > 500 ? 'warn' : '',
            hint: 'Disagreements between the five upstream sources found by the API validation rules. These are metadata conflicts, not service failures.'
        })
    ];
    clear(wrap);
    for (const t of tiles) wrap.appendChild(t);
    // The HTML skeleton has been replaced by real values.
    wrap.removeAttribute('aria-busy');
}

function totalTvs() {
    return state.l2beatProjects.reduce((s, p) => s + (p.tvs || 0), 0);
}

// ── Live incident impact ────────────────────────────────────────────────
// One row per (network, open incident) pair. Provider incidents fan out, so a
// single provider outage legitimately produces several rows.

function buildImpactRows() {
    const rows = [];
    for (const it of openIncidents()) {
        if (impactScope === 'chain' && it.isProvider) continue;
        if (impactScope === 'provider' && !it.isProvider) continue;
        if (it.chainIds.length) {
            for (const id of it.chainIds) rows.push({ chainId: id, incident: it });
        } else {
            // Provider-wide with no chain named — still worth showing, but never
            // attributed to a chain we cannot identify.
            rows.push({ chainId: null, incident: it });
        }
    }
    rows.sort((a, b) => {
        const d = (SEVERITY_RANK[severityOf(b.incident).key] || 0) - (SEVERITY_RANK[severityOf(a.incident).key] || 0);
        if (d) return d;
        return (b.incident.whenMs || 0) - (a.incident.whenMs || 0);
    });
    return rows;
}

function renderImpact() {
    const host = byId('impactBody');
    if (!host) return;
    const rows = buildImpactRows();
    clear(host);

    if (!rows.length) {
        host.appendChild(el('div', {
            class: 'feed-empty',
            text: incidents.items.length
                ? 'Nothing open in this scope — every incident the feed retains is resolved or completed.'
                : 'Waiting for the live status feed…'
        }));
        return;
    }

    // The panel is a bounded scroll region, so every row can be rendered: there
    // is no layout cost to more rows and no expander to hunt for.
    const shown = rows;
    const table = el('table', { class: 'data-table data-table--stack' }, [
        el('caption', { class: 'sr-only', text: 'Networks affected by open incidents' }),
        el('thead', {}, [el('tr', {}, [
            el('th', { scope: 'col', text: 'Network' }),
            el('th', { scope: 'col', text: 'Type' }),
            el('th', { scope: 'col', text: 'Incident' }),
            el('th', { scope: 'col', text: 'Severity' }),
            el('th', { scope: 'col', text: 'State' }),
            el('th', { scope: 'col', text: 'Duration' })
        ])])
    ]);
    const tbody = el('tbody');

    for (const r of shown) {
        const c = r.chainId != null ? state.byId.get(r.chainId) : null;
        const it = r.incident;
        const sev = severityOf(it);
        const dur = durationInfo(it);
        const cls = c ? netClass(c) : null;

        const nameCell = td('Network', [], { primary: true });
        if (c) {
            nameCell.appendChild(el('div', { class: 'cell-stack' }, [
                el('span', { class: 'cell-name', text: c.name || `Chain ${r.chainId}` }),
                el('span', { class: 'cell-sub', text: `ID ${r.chainId}` })
            ]));
        } else {
            nameCell.appendChild(el('div', { class: 'cell-stack' }, [
                el('span', { class: 'cell-name muted', text: 'No chain named' }),
                el('span', { class: 'cell-sub', text: it.affectedComponents.slice(0, 2).join(', ') || 'provider-wide' })
            ]));
        }

        const sevMark = el('span', { class: 'sev-mark' });
        const tr = el('tr', c ? { class: 'is-clickable', onclick: () => openChainDetail(r.chainId) } : {}, [
            nameCell,
            td('Type', [cls ? typeTag(cls) : el('span', { class: 'dim', text: '—' })], { empty: !cls }),
            // The title has to be on the row: several distinct incidents can hit
            // the same chain at the same severity, and without it those rows are
            // indistinguishable duplicates.
            td('Incident', [el('div', { class: 'cell-stack' }, [
                it.url
                    ? el('a', {
                        href: it.url, target: '_blank', rel: 'noopener',
                        text: it.title, title: it.title,
                        // The row opens the chain drawer; the link opens the
                        // upstream report. Don't fire both.
                        onclick: e => e.stopPropagation()
                    })
                    : el('span', { text: it.title, title: it.title }),
                el('span', {
                    class: 'cell-sub',
                    text: `${it.isProvider ? it.spName : it.netName} · ${it.isProvider ? 'RPC provider' : it.pageKind === 'coin' ? 'coin status page' : 'chain operator'}`
                })
            ])], { cls: 'cell-incident' }),
            td('Severity', [el('span', { class: `sev sev-${sev.key}` }, [sevMark, sev.label])]),
            td('State', [el('span', { class: 'pill', text: it.status || 'Unknown' })]),
            td('Duration', [dur
                ? el('span', { class: 'incident-dur', title: dur.title, text: dur.text })
                : el('span', { class: 'dim', text: '—' })], { empty: !dur })
        ]);
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    host.appendChild(el('div', { class: 'table-wrap' }, [table]));

    const summary = el('p', { class: 'note' });
    const providerRows = rows.filter(r => r.incident.isProvider).length;
    summary.textContent =
        `${fmtNum(rows.length)} network-incident pair${rows.length === 1 ? '' : 's'} from ` +
        `${fmtNum(new Set(rows.map(r => r.incident.key)).size)} open incident${rows.length === 1 ? '' : 's'}` +
        `${providerRows ? ` · ${fmtNum(providerRows)} via RPC-provider fan-out` : ''}.` +
        ' Severity is an AI classification from the feed; unclassified events are shown as such.';
    host.appendChild(summary);

}

// ── TVS distribution charts ─────────────────────────────────────────────
// These are the genuinely new analytics: /summary already ships category,
// stage, stack and daLayer per project and the old dashboard surfaced none of
// it. Each is one series, so one hue and no legend — bar length is the
// encoding and colouring bars by their own value would waste the hue channel.

// Stage is an ordinal ladder, so keep it in ladder order rather than sorting by
// value; the reader is comparing rungs, not ranking them.
const STAGE_ORDER = ['Stage 0', 'Stage 1', 'Stage 2', 'Not applicable'];

function aggregateTvs(field, { order = null, topN = null } = {}) {
    const agg = new Map();
    for (const p of state.l2beatProjects) {
        const key = p[field] || 'Unspecified';
        const cur = agg.get(key) || { value: 0, count: 0 };
        cur.value += p.tvs || 0;
        cur.count += 1;
        agg.set(key, cur);
    }
    let entries = [...agg.entries()].map(([label, v]) => ({
        label, value: v.value,
        sub: { label: 'Projects', value: fmtNum(v.count) }
    }));
    if (order) {
        entries.sort((a, b) => {
            const ai = order.indexOf(a.label), bi = order.indexOf(b.label);
            return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
        });
    } else {
        entries.sort((a, b) => b.value - a.value);
    }
    if (topN) entries = entries.slice(0, topN);
    return entries;
}

function mountChart(containerId, actionsId, render) {
    const container = byId(containerId);
    if (!container) return;
    const result = render(container);
    const actions = byId(actionsId);
    if (actions && result?.table) {
        clear(actions);
        container.appendChild(result.table);
        Viz.attachTableToggle(container, result.table, actions);
    }
}

// Build a chart only once it is near the viewport. Four bar charts plus the
// composition bar cost ~77 ms in one task on a throttled phone, and on a narrow
// screen they all start below the fold — so that work was blocking the main
// thread for something the reader could not see yet. Anything already at or
// near the top renders synchronously, so the fold is never empty.
const chartObservers = new WeakMap();
function renderWhenVisible(container, fn) {
    if (!container) return;
    if (!('IntersectionObserver' in window)) { fn(); return; }
    const rect = container.getBoundingClientRect();
    if (rect.top < window.innerHeight * 1.25) { fn(); return; }

    const existing = chartObservers.get(container);
    if (existing) existing.disconnect();
    const io = new IntersectionObserver(entries => {
        if (!entries.some(e => e.isIntersecting)) return;
        io.disconnect();
        chartObservers.delete(container);
        fn();
    }, { rootMargin: '240px 0px' });
    chartObservers.set(container, io);
    io.observe(container);
}

// Signature of the data these charts are derived from. Cheap to compute and
// exact enough: L2BEAT replaces its payload wholesale on each refresh.
function tvsDataSignature() {
    return `${state.l2beatMeta?.fetchedAt ?? ''}|${state.l2beatMeta?.source ?? ''}|${state.l2beatProjects.length}`;
}
let tvsRenderedSignature = null;
let tvsRenderedWidth = 0;

function renderTvsCharts({ force = false } = {}) {
    if (!state.l2beatProjects.length) return;
    // Re-render on a real data change or a width change (the charts are laid out
    // against container width), never just because something else repainted.
    const sig = tvsDataSignature();
    const width = byId('chartTvsStage')?.clientWidth || 0;
    if (!force && sig === tvsRenderedSignature && width === tvsRenderedWidth) return;
    tvsRenderedSignature = sig;
    tvsRenderedWidth = width;

    const usd = { valueFmt: fmtUsd, axisFmt: Viz.fmtAxisUsd, unit: 'Value secured (USD)' };

    renderWhenVisible(byId('chartTvsStage'), () => mountChart('chartTvsStage', 'tvsStageActions', c =>
        Viz.barChart(c, { ...usd, data: aggregateTvs('stage', { order: STAGE_ORDER }), tableCaption: 'Value secured by rollup stage' })));

    renderWhenVisible(byId('chartTvsDa'), () => mountChart('chartTvsDa', 'tvsDaActions', c =>
        Viz.barChart(c, { ...usd, data: aggregateTvs('daLayer'), tableCaption: 'Value secured by data-availability layer' })));

    renderWhenVisible(byId('chartTvsStack'), () => mountChart('chartTvsStack', 'tvsStackActions', c =>
        Viz.barChart(c, { ...usd, data: aggregateTvs('stack'), tableCaption: 'Value secured by stack' })));

    // Top projects. Only the ~25 projects the registry could match to a chain
    // ID are clickable; the rest have no chain to open.
    const top = state.l2beatProjects
        .filter(p => (p.tvs || 0) > 0)
        .sort((a, b) => b.tvs - a.tvs)
        .slice(0, 12)
        .map(p => ({
            label: p.displayName || p.slug,
            value: p.tvs,
            id: p.chainId ?? null,
            sub: { label: 'Stage', value: p.stage || 'n/a' }
        }));
    renderWhenVisible(byId('chartTvsTop'), () => mountChart('chartTvsTop', 'tvsTopActions', c =>
        Viz.barChart(c, {
            ...usd, data: top, tableCaption: 'Largest networks by value secured',
            onSelect: id => { if (id != null) openChainDetail(id); }
        })));
}

let concRenderedSignature = null;
let concRenderedWidth = 0;
function renderConcentration({ force = false } = {}) {
    const host = byId('chartConcentration');
    if (!host || !state.l2beatProjects.length) return;
    const sig = tvsDataSignature();
    if (!force && sig === concRenderedSignature && host.clientWidth === concRenderedWidth) return;
    concRenderedSignature = sig;
    concRenderedWidth = host.clientWidth;
    const sorted = state.l2beatProjects
        .filter(p => (p.tvs || 0) > 0)
        .sort((a, b) => b.tvs - a.tvs);
    if (!sorted.length) return;

    const parts = sorted.slice(0, 4).map(p => ({ label: p.displayName || p.slug, value: p.tvs }));
    const restVal = sorted.slice(4).reduce((s, p) => s + p.tvs, 0);
    if (restVal > 0) parts.push({ label: `Other (${sorted.length - 4})`, value: restVal });

    renderWhenVisible(host, () => paintConcentration(host, sorted, parts));
}

function paintConcentration(host, sorted, parts) {
    const res = Viz.compositionBar(host, {
        parts, valueFmt: fmtUsd, maxSlots: 4,
        tableCaption: 'Share of total value secured'
    });
    const actions = byId('concentrationActions');
    if (actions && res?.table) {
        clear(actions);
        host.appendChild(res.table);
        Viz.attachTableToggle(host, res.table, actions);
    }
    const total = totalTvs();
    const top4 = sorted.slice(0, 4).reduce((s, p) => s + p.tvs, 0);
    host.appendChild(el('p', {
        class: 'note',
        text: `The four largest projects hold ${Viz.fmtPct((top4 / total) * 100)} of ${fmtUsd(total)} total value secured across ${fmtNum(sorted.length)} projects reporting a non-zero figure.`
    }));
}

// ── Data quality ────────────────────────────────────────────────────────
const RULE_LABELS = {
    rule1: 'Conflicting relations between sources',
    rule2: 'SLIP-44 coin type on a testnet',
    rule3: 'Name says testnet but the tag disagrees',
    rule4: 'Sepolia / Hoodi naming problems',
    rule5: 'Lifecycle status conflicts',
    rule6: 'Goerli chains not marked deprecated',
    rule7: 'L2BEAT project missing a classification',
    rule8: 'L2BEAT host chain with no relation',
    rule9: 'L2BEAT category disagrees with the name',
    rule10: 'L2BEAT project not in the registry',
    rule11: 'Stage 0 rollup holding high value',
    rule12: 'RPC endpoints disagree on block height',
    rule13: 'Sources disagree on the network name',
    rule14: 'Native currency mismatch',
    rule15: 'SLIP-44 symbol vs native symbol mismatch',
    rule16: 'RPC URL present in only one source',
    rule17: 'Active chain under a deprecated parent'
};

function renderDataQuality() {
    const host = byId('dataQualityBody');
    if (!host) return;
    const v = state.validate;
    if (!v) return;

    const meta = byId('validateMeta');
    if (meta) meta.textContent = `${fmtNum(v.totalErrors)} findings`;

    const rules = Object.entries(v.summary || {})
        .map(([k, n]) => ({ key: k, label: RULE_LABELS[k] || k, count: n }))
        .filter(r => r.count > 0)
        .sort((a, b) => b.count - a.count);

    clear(host);
    if (!rules.length) {
        host.appendChild(el('div', { class: 'feed-empty', text: 'No cross-source conflicts found.' }));
        return;
    }
    const max = Math.max(...rules.map(r => r.count));
    const list = el('div', { class: 'kv-list' });
    for (const r of rules) {
        const bar = el('div', { class: 'kv-bar' }, [el('div', { class: 'kv-bar-fill' })]);
        bar.firstChild.style.width = `${(r.count / max) * 100}%`;
        list.appendChild(el('div', { class: 'kv-row' }, [
            el('span', { class: 'kv-key', text: r.label }),
            bar,
            el('span', { class: 'kv-val', text: fmtNum(r.count) })
        ]));
    }
    host.appendChild(list);
    const clean = 17 - rules.length;
    host.appendChild(el('p', {
        class: 'note',
        text: `${clean} of 17 rules found nothing. These are disagreements between upstream sources — most are metadata noise, but block-height drift and status conflicts are worth reading.`
    }));
}

// ── Source freshness ────────────────────────────────────────────────────
function renderFreshness() {
    const host = byId('freshnessBody');
    if (!host) return;
    const hd = state.health;
    if (!hd) return;

    const meta = byId('healthMeta');
    if (meta) {
        meta.textContent = hd.status === 'ok' ? 'healthy' : hd.status;
        meta.title = hd.version ? `API version ${hd.version}` : '';
    }

    clear(host);
    const list = el('div', { class: 'kv-list' });
    for (const [key, s] of Object.entries(hd.sources || {})) {
        const label = SOURCE_LABELS[key] || key;
        const ok = s.loaded;
        const extra = s.source ? ` · ${s.source}` : '';
        list.appendChild(el('div', { class: 'kv-row' }, [
            el('span', { class: `dot ${ok ? 'dot-ok' : 'dot-bad'}` }),
            el('span', { class: 'kv-key', text: label }),
            el('span', {
                class: 'kv-val',
                text: `${ok ? fmtAge(s.ageSeconds) : 'not loaded'}${extra}`
            })
        ]));
    }
    host.appendChild(list);

    const r = hd.refreshers || {};
    const notes = [];
    if (r.rpc) notes.push(`RPC sweep ${r.rpc.isRunning ? 'running' : 'idle'}, last ${relTime(r.rpc.lastRunAt)}`);
    if (r.l2beat) {
        notes.push(`L2BEAT refresh every ${Math.round((r.l2beat.intervalMs || 0) / 60000)}m, last ${relTime(r.l2beat.lastRefreshAt)} from ${r.l2beat.lastRefreshSource || 'unknown'}`);
    }
    // The four registry sources share one timestamp server-side, so say so
    // rather than implying four independent freshness readings.
    notes.push('The four registry sources report a single shared build time; only L2BEAT refreshes independently.');
    host.appendChild(el('p', { class: 'note', text: notes.join(' · ') }));
}

// ═════════════════════════════════════════════════════════════════════════
// Networks table
// ═════════════════════════════════════════════════════════════════════════
let chainSort = { key: 'chainId', dir: 1 };
let chainTypeFilter = 'all';
let chainStatusFilter = 'all';
let chainIncidentOnly = false;
let chainTvsOnly = false;
// A stacked card is far taller than a table row, so a phone gets a smaller
// first page. pageSize() is read at render time, not cached, so rotating the
// device picks up the new size on the next paint.
const CHAIN_PAGE = 100;
const CHAIN_PAGE_NARROW = 25;
function chainPageSize() { return isNarrow() ? CHAIN_PAGE_NARROW : CHAIN_PAGE; }
// null means "whatever this breakpoint's default is" — so rotating to a phone
// really does shrink the list, while an explicit "show more" is remembered.
let chainShown = null;
// Set when bulk data lands while Networks is not the active view.
let chainsTableStale = false;

function initChainsTable() {
    document.querySelectorAll('#chainsTable thead th[data-sort]').forEach(th => {
        const activate = () => {
            const k = th.dataset.sort;
            chainSort.dir = chainSort.key === k ? -chainSort.dir : 1;
            chainSort.key = k;
            // aria-sort must reflect the real state — screen readers announce it
            // and the caret is driven from the same attribute.
            document.querySelectorAll('#chainsTable thead th[data-sort]').forEach(o =>
                o.setAttribute('aria-sort', 'none'));
            th.setAttribute('aria-sort', chainSort.dir === 1 ? 'ascending' : 'descending');
            renderChainsTable();
        };
        th.setAttribute('tabindex', '0');
        th.addEventListener('click', activate);
        th.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
        });
    });

    byId('chipIncidentOnly')?.addEventListener('click', e => {
        chainIncidentOnly = !chainIncidentOnly;
        e.currentTarget.setAttribute('aria-pressed', String(chainIncidentOnly));
        chainShown = null;
        renderChainsTable();
    });
    byId('chipTvsOnly')?.addEventListener('click', e => {
        chainTvsOnly = !chainTvsOnly;
        e.currentTarget.setAttribute('aria-pressed', String(chainTvsOnly));
        chainShown = null;
        renderChainsTable();
    });
}

// Filter chips carry real counts, so the reader knows how many rows a filter
// will produce before clicking it.
function renderChainFilters() {
    const typeWrap = byId('chainTypeChips');
    if (typeWrap) {
        const counts = new Map(NET_CLASS_ORDER.map(k => [k, 0]));
        for (const c of state.chains) {
            const k = netClass(c).key;
            counts.set(k, (counts.get(k) || 0) + 1);
        }
        clear(typeWrap);
        const mk = (key, label, count, dotClass) => {
            const chip = el('button', {
                class: 'chip', type: 'button',
                'aria-pressed': String(chainTypeFilter === key),
                onclick: () => {
                    chainTypeFilter = key;
                    chainShown = null;
                    renderChainFilters();
                    renderChainsTable();
                }
            }, [
                dotClass ? el('span', { class: `chip-dot ${dotClass}` }) : null,
                label,
                count != null ? el('span', { class: 'chip-count', text: fmtNum(count) }) : null
            ]);
            typeWrap.appendChild(chip);
        };
        mk('all', 'All', state.chains.length, null);
        for (const k of NET_CLASS_ORDER) {
            const cls = NET_CLASSES[k];
            if (!counts.get(k)) continue;
            mk(k, cls.label, counts.get(k), cls.dot);
        }
    }

    const statusWrap = byId('chainStatusChips');
    if (statusWrap) {
        const byStatus = state.stats?.byStatus || {};
        clear(statusWrap);
        const mk = (key, label, count) => statusWrap.appendChild(el('button', {
            class: 'chip', type: 'button',
            'aria-pressed': String(chainStatusFilter === key),
            onclick: () => {
                chainStatusFilter = key;
                chainShown = null;
                renderChainFilters();
                renderChainsTable();
            }
        }, [label, count != null ? el('span', { class: 'chip-count', text: fmtNum(count) }) : null]));
        mk('all', 'Any', null);
        mk('active', 'Active', byStatus.active);
        mk('deprecated', 'Deprecated', byStatus.deprecated);
        mk('incubating', 'Incubating', byStatus.incubating);
    }

    const ic = byId('chipIncidentCount');
    if (ic) ic.textContent = state.openByChain.size ? fmtNum(state.openByChain.size) : '';
}

// /summary omits `status` when the chain is active, so absence means active —
// never render "unknown" for it.
function statusOf(c) { return c.status || 'active'; }

function chainRow(c) {
    const l2b = state.l2beat.get(c.chainId);
    const open = state.openByChain.get(c.chainId) || [];
    const worst = open.length ? severityOf(open[0]) : null;
    return {
        chainId: c.chainId,
        name: c.name || `Chain ${c.chainId}`,
        cls: netClass(c),
        type: netClass(c).label,
        tags: classTags(c),
        stage: l2b?.stage || '',
        tvs: l2b?.tvs ?? null,
        rpcs: c.rpcCount ?? 0,
        status: statusOf(c),
        openCount: open.length,
        // Sort key for the incident column: severity rank, then count.
        incident: open.length ? (SEVERITY_RANK[worst.key] || 0) * 1000 + open.length : 0,
        worst, open
    };
}

function renderChainsTable() {
    const body = byId('chainsTableBody');
    if (!body) return;
    const q = searchQuery;

    let rows = state.chains.filter(c => {
        if (chainTypeFilter !== 'all' && netClass(c).key !== chainTypeFilter) return false;
        if (chainStatusFilter !== 'all' && statusOf(c) !== chainStatusFilter) return false;
        if (chainIncidentOnly && !state.openByChain.has(c.chainId)) return false;
        if (chainTvsOnly && !(state.l2beat.get(c.chainId)?.tvs > 0)) return false;
        if (q && !chainMatchesQuery(c, q)) return false;
        return true;
    }).map(chainRow);

    const { key, dir } = chainSort;
    rows.sort((a, b) => {
        let av = a[key], bv = b[key];
        if (key === 'tvs') { av = av ?? -1; bv = bv ?? -1; }
        if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
        return String(av).localeCompare(String(bv)) * dir;
    });

    const countEl = byId('chainsCount');
    if (countEl) {
        const total = state.chains.length;
        countEl.textContent = rows.length === total
            ? `${fmtNum(total)} networks`
            : `${fmtNum(rows.length)} of ${fmtNum(total)} networks`;
    }

    const limit = chainShown ?? chainPageSize();

    clear(body);
    if (!rows.length) {
        body.appendChild(el('tr', {}, [
            el('td', { colspan: '8', class: 'cell-primary' }, [el('div', {
                class: 'table-empty',
                text: state.chains.length
                    ? 'No networks match these filters.'
                    : 'Loading networks…'
            })])
        ]));
        byId('chainsTableMore')?.classList.add('hidden');
        return;
    }

    for (const r of rows.slice(0, limit)) {
        // On mobile this becomes the card's heading, so fold the ID in — the
        // separate ID column is dropped from the stacked layout.
        const nameCell = td('Network', [el('div', { class: 'cell-stack' }, [
            el('span', { class: 'cell-name', text: r.name }),
            el('span', { class: 'cell-sub', text: [`ID ${r.chainId}`, ...r.tags].join(' · ') })
        ])], { primary: true });

        let incidentCell;
        if (r.openCount) {
            incidentCell = el('span', { class: `sev sev-${r.worst.key}`, title: r.open.map(i => i.title).slice(0, 4).join('\n') }, [
                el('span', { class: 'sev-mark' }),
                r.openCount > 1 ? `${r.worst.label} +${r.openCount - 1}` : r.worst.label
            ]);
        } else {
            incidentCell = el('span', { class: 'dim', text: '—' });
        }

        body.appendChild(el('tr', {
            class: 'is-clickable', 'data-id': r.chainId,
            onclick: () => openChainDetail(r.chainId)
        }, [
            // The ID column is redundant once the card heading carries it, so it
            // is the one cell hidden outright on small screens.
            td('ID', [String(r.chainId)], { num: true, cls: 'mono col-id' }),
            nameCell,
            td('Type', [typeTag(r.cls)]),
            td('Stage', [r.stage
                ? el('span', { class: 'pill pill-stage', text: r.stage })
                : el('span', { class: 'dim', text: '—' })], { empty: !r.stage }),
            td('Value secured', [r.tvs != null ? fmtUsd(r.tvs) : '—'], { num: true, empty: r.tvs == null }),
            td('RPCs', [r.rpcs ? fmtNum(r.rpcs) : '—'], { num: true, empty: !r.rpcs }),
            td('Status', [el('span', { class: `pill pill-${r.status}`, text: r.status })]),
            td('Incident', [incidentCell], { empty: !r.openCount })
        ]));
    }

    const more = byId('chainsTableMore');
    if (more) {
        clear(more);
        if (rows.length > limit) {
            more.classList.remove('hidden');
            more.appendChild(el('button', {
                class: 'btn', type: 'button',
                text: `Show more — ${fmtNum(rows.length - limit)} remaining`,
                onclick: () => { chainShown = limit + chainPageSize() * 3; renderChainsTable(); }
            }));
        } else {
            more.classList.add('hidden');
        }
    }
}

// ═════════════════════════════════════════════════════════════════════════
// Relationships — 3D force graph
//
// The old graph encoded almost nothing: node size was a constant per type and
// only two of the four relation kinds were drawn. Now size carries a real
// measure (value secured or RPC count), all four relation kinds are drawn with
// distinct colours, and an emphasis mode dims networks with no open incident.
//
// There is no per-node ring: the bundled 3d-force-graph build reads
// window.THREE but never assigns it, so custom node geometry is not available.
// Emphasis-by-dimming is used instead, which the legend states accurately.
// ═════════════════════════════════════════════════════════════════════════
let graphData = { nodes: [], links: [] };
let filteredData = { nodes: [], links: [] };
let graphTypeFilter = 'all';
let graphSizeMode = 'tvs';
let graphEmphasizeIncidents = false;
let enabledSources = new Set(ALL_SOURCES);
let myGraph = null;
let graphBuilt = false;
let graphDirty = true;
let graphLibPromise = null;

const LINK_KINDS = {
    l2Of: { label: 'L2 → its L1', cssVar: '--cat-2' },
    testnetOf: { label: 'Testnet → its mainnet', cssVar: '--cat-3' }
};

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

// The 3D graph is the only WebGL surface in the dashboard, and its render loop
// does NOT stop when the section is hidden — measured at ~134k draw calls/sec
// while sitting on another tab, which is a straight battery drain on a phone.
// Pause it on the way out and resume on the way in.
function pauseGraph() {
    if (myGraph?.pauseAnimation) { try { myGraph.pauseAnimation(); } catch { /* older build */ } }
}
function resumeGraph() {
    if (myGraph?.resumeAnimation) { try { myGraph.resumeAnimation(); } catch { /* older build */ } }
}

async function ensureGraphView() {
    resumeGraph();
    if (myGraph) setTimeout(() => myGraph.width(window.innerWidth).height(window.innerHeight), 0);
    if (!state.chains.length) return;   // still loading; applyBulk re-enters
    try { await ensureGraphLib(); } catch { showLoadError(); return; }
    if (activeView !== 'graph') return; // tabbed away while the lib loaded
    if (graphDirty) { buildGraph(); applyGraphFilter(); graphDirty = false; }
    renderGraphLegend();
}

function initGraphControls() {
    // Type filter chips are generated from the same taxonomy as everything else.
    const filterWrap = byId('graphFilterChips');
    if (filterWrap) {
        const mk = (key, label, dotClass) => filterWrap.appendChild(el('button', {
            class: 'chip', type: 'button', 'data-filter': key,
            'aria-pressed': String(graphTypeFilter === key),
            onclick: () => {
                graphTypeFilter = key;
                filterWrap.querySelectorAll('.chip').forEach(c =>
                    c.setAttribute('aria-pressed', String(c.dataset.filter === key)));
                applyGraphFilter();
            }
        }, [dotClass ? el('span', { class: `chip-dot ${dotClass}` }) : null, label]));
        mk('all', 'All', null);
        for (const k of NET_CLASS_ORDER) mk(k, NET_CLASSES[k].label, NET_CLASSES[k].dot);
    }

    document.querySelectorAll('#graphSizeChips .chip').forEach(chip => {
        chip.addEventListener('click', () => {
            graphSizeMode = chip.dataset.size;
            document.querySelectorAll('#graphSizeChips .chip').forEach(c =>
                c.setAttribute('aria-pressed', String(c === chip)));
            buildGraph();
            applyGraphFilter();
            renderGraphLegend();
        });
    });

    byId('graphIncidentEmphasis')?.addEventListener('click', e => {
        graphEmphasizeIncidents = !graphEmphasizeIncidents;
        e.currentTarget.setAttribute('aria-pressed', String(graphEmphasizeIncidents));
        applyGraphFilter();
        renderGraphLegend();
    });

    byId('graphReset')?.addEventListener('click', () => {
        if (myGraph) myGraph.cameraPosition({ x: 0, y: 0, z: 900 }, { x: 0, y: 0, z: 0 }, 800);
    });

    const srcWrap = byId('graphSources');
    if (srcWrap) {
        for (const s of ALL_SOURCES) {
            const cb = el('input', { type: 'checkbox', checked: 'checked', 'data-source': s });
            cb.addEventListener('change', () => {
                if (cb.checked) enabledSources.add(s); else enabledSources.delete(s);
                buildGraph();
                applyGraphFilter();
            });
            srcWrap.appendChild(el('label', { class: 'check-row' }, [cb, SOURCE_LABELS[s] || s]));
        }
    }
}

function visibleChains() {
    if (enabledSources.size === ALL_SOURCES.length) return state.chains;
    return state.chains.filter(c => c.sources?.some(s => enabledSources.has(s)));
}

// Node size: area should scale with the measure, and force-graph's `val` maps
// to volume, so take a root to keep large values from swamping the scene.
function nodeVal(c) {
    if (graphSizeMode === 'flat') return 2;
    if (graphSizeMode === 'rpc') {
        const n = c.rpcCount || 0;
        return 1 + 5 * Math.sqrt(n / 40);
    }
    const tvs = state.l2beat.get(c.chainId)?.tvs || 0;
    if (!tvs) return 1;
    const maxTvs = graphMaxTvs();
    return 2 + 12 * Math.sqrt(tvs / maxTvs);
}
let _maxTvsCache = null;
function graphMaxTvs() {
    if (_maxTvsCache == null) {
        _maxTvsCache = Math.max(1, ...state.l2beatProjects.map(p => p.tvs || 0));
    }
    return _maxTvsCache;
}

function buildGraph() {
    if (!globalThis.ForceGraph3D) { graphDirty = true; return; }
    _maxTvsCache = null;
    const chains = visibleChains();
    const ids = new Set(chains.map(c => c.chainId));
    const nodes = [];
    for (const c of chains) {
        const cls = netClass(c);
        let name = c.name || `Chain ${c.chainId}`;
        const l2b = state.l2beat.get(c.chainId);
        nodes.push({
            id: c.chainId, name, classKey: cls.key,
            val: nodeVal(c),
            tvs: l2b?.tvs ?? null,
            rpcCount: c.rpcCount || 0
        });
    }
    // All four relation kinds fold into two drawn edges per chain (the reverse
    // edges parentOf/mainnetOf point at the same pairs).
    const links = [];
    for (const c of chains) {
        const e = state.rel.get(c.chainId);
        if (!e) continue;
        if (e.l1Parent != null && ids.has(e.l1Parent)) links.push({ source: c.chainId, target: e.l1Parent, kind: 'l2Of' });
        if (e.mainnet != null && ids.has(e.mainnet)) links.push({ source: c.chainId, target: e.mainnet, kind: 'testnetOf' });
    }
    graphData = { nodes, links };
    filteredData = { nodes: [...nodes], links: [...links] };
    if (!graphBuilt) {
        renderGraph();
        graphBuilt = true;
        byId('loadingOverlay')?.classList.add('hidden');
    }
}

function linksFor(idSet) {
    return graphData.links.filter(l => {
        const s = l.source.id ?? l.source, t = l.target.id ?? l.target;
        return idSet.has(s) && idSet.has(t);
    });
}

function applyGraphFilter() {
    if (graphTypeFilter === 'all') {
        filteredData = { nodes: [...graphData.nodes], links: [...graphData.links] };
    } else {
        // Pull in each match's parent so the selection keeps its context.
        const set = new Set();
        for (const n of graphData.nodes) {
            if (n.classKey !== graphTypeFilter) continue;
            set.add(n.id);
            const e = state.rel.get(n.id);
            if (e?.l1Parent != null) set.add(e.l1Parent);
            if (e?.mainnet != null) set.add(e.mainnet);
        }
        filteredData = { nodes: graphData.nodes.filter(n => set.has(n.id)), links: linksFor(set) };
    }
    if (myGraph) myGraph.graphData(filteredData);
    const nc = byId('graphNodeCount');
    const lc = byId('graphLinkCount');
    if (nc) nc.textContent = fmtNum(filteredData.nodes.length);
    if (lc) lc.textContent = fmtNum(filteredData.links.length);
}

function nodeColorFor(n) {
    const base = Viz.cssVar(NET_CLASSES[n.classKey]?.cssVar || '--cat-0');
    if (!graphEmphasizeIncidents) return base;
    // Emphasis form: the affected networks keep their identity colour, the rest
    // recede toward the background.
    return state.openByChain.has(n.id) ? base : Viz.mix(base, Viz.cssVar('--page'), 0.82);
}

function renderGraph() {
    myGraph = ForceGraph3D()(byId('graph-canvas'))
        .graphData(filteredData)
        .nodeLabel(n => {
            const bits = [n.name, `ID ${n.id}`, NET_CLASSES[n.classKey]?.label];
            if (n.tvs) bits.push(`Value secured ${fmtUsd(n.tvs)}`);
            if (n.rpcCount) bits.push(`${n.rpcCount} RPC endpoints`);
            const open = state.openByChain.get(n.id);
            if (open?.length) bits.push(`${open.length} open incident${open.length === 1 ? '' : 's'}`);
            return bits.filter(Boolean).join(' · ');
        })
        .nodeColor(nodeColorFor)
        .nodeVal('val')
        .nodeResolution(10)
        .nodeOpacity(0.92)
        .linkColor(l => {
            const c = Viz.cssVar(LINK_KINDS[l.kind]?.cssVar || '--rule-strong');
            return Viz.mix(c, Viz.cssVar('--page'), 0.45);
        })
        .linkWidth(0.7)
        .linkDirectionalParticles(2)
        .linkDirectionalParticleSpeed(0.004)
        .linkDirectionalParticleWidth(1.2)
        .linkDirectionalParticleColor(l => Viz.cssVar(LINK_KINDS[l.kind]?.cssVar || '--rule-strong'))
        .backgroundColor(Viz.cssVar('--page'))
        .warmupTicks(80)
        .cooldownTicks(60)
        .onNodeClick(n => { focusNode(n); openChainDetail(n.id); });
    window.addEventListener('resize', () => {
        if (myGraph) myGraph.width(window.innerWidth).height(window.innerHeight);
    });
}

function renderGraphLegend() {
    const colorWrap = byId('graphLegendColor');
    if (colorWrap) {
        clear(colorWrap);
        for (const k of NET_CLASS_ORDER) {
            const cls = NET_CLASSES[k];
            const sw = el('span', { class: 'legend-swatch' });
            sw.style.background = Viz.cssVar(cls.cssVar);
            sw.style.borderRadius = '50%';
            colorWrap.appendChild(el('span', { class: 'legend-item' }, [sw, cls.label]));
        }
    }
    const sizeWrap = byId('graphLegendSize');
    if (sizeWrap) {
        clear(sizeWrap);
        const label = graphSizeMode === 'tvs' ? 'Value secured'
            : graphSizeMode === 'rpc' ? 'RPC endpoint count' : 'Uniform (no measure)';
        const ramp = el('span', { class: 'legend-size' });
        for (const d of [4, 7, 11]) {
            const i = el('i');
            i.style.width = `${d}px`;
            i.style.height = `${d}px`;
            ramp.appendChild(i);
        }
        sizeWrap.appendChild(el('span', { class: 'legend-item' }, [ramp, label]));
        if (graphSizeMode === 'tvs') {
            sizeWrap.appendChild(el('span', {
                class: 'legend-item legend-count',
                text: 'Unclassified chains take the minimum size'
            }));
        }
    }
    const linkWrap = byId('graphLegendLinks');
    if (linkWrap) {
        clear(linkWrap);
        for (const [, def] of Object.entries(LINK_KINDS)) {
            const line = el('span', { class: 'legend-line' });
            line.style.background = Viz.cssVar(def.cssVar);
            linkWrap.appendChild(el('span', { class: 'legend-item' }, [line, def.label]));
        }
    }
    const emph = byId('graphLegendEmphasis');
    if (emph) {
        clear(emph);
        emph.appendChild(el('div', { class: 'legend-title', text: 'Highlight' }));
        emph.appendChild(el('div', { class: 'chart-legend' }, [
            el('span', {
                class: 'legend-item',
                text: graphEmphasizeIncidents
                    ? `${fmtNum(state.openByChain.size)} networks with an open incident keep full colour; the rest are dimmed`
                    : 'Off — enable to dim networks with no open incident'
            })
        ]));
    }
}

function focusNode(node) {
    if (!myGraph || node.x == null) return;
    const r = 1 + 150 / Math.hypot(node.x, node.y, node.z);
    myGraph.cameraPosition({ x: node.x * r, y: node.y * r, z: node.z * r }, node, 1200);
}
function focusNodeById(id) {
    const n = filteredData.nodes.find(x => x.id === id) || graphData.nodes.find(x => x.id === id);
    if (n) focusNode(n);
}

// ═════════════════════════════════════════════════════════════════════════
// Incidents view
// ═════════════════════════════════════════════════════════════════════════
function chainIncidents() { return incidents.items.filter(it => !it.isProvider); }

function visibleIncidents() {
    let items = chainIncidents();
    if (incidents.category !== 'all') items = items.filter(it => it.kind === incidents.category);
    if (incidents.severity !== 'all') items = items.filter(it => severityOf(it).key === incidents.severity);
    return items;
}

function initIncidentControls() {
    byId('grpFlat')?.addEventListener('click', () => setGroupBy('flat'));
    byId('grpNetwork')?.addEventListener('click', () => setGroupBy('network'));
    document.querySelectorAll('#incidentCategory .chip').forEach(chip =>
        chip.addEventListener('click', () => setCategory(chip.dataset.cat)));
}
function setGroupBy(mode) {
    incidents.groupBy = mode;
    byId('grpFlat')?.setAttribute('aria-pressed', String(mode === 'flat'));
    byId('grpNetwork')?.setAttribute('aria-pressed', String(mode === 'network'));
    renderIncidentList();
}
function setCategory(cat) {
    incidents.category = cat;
    incidents.shown = null;
    document.querySelectorAll('#incidentCategory .chip').forEach(c =>
        c.setAttribute('aria-pressed', String(c.dataset.cat === cat)));
    renderIncidents();
}
function setSeverity(sev) {
    incidents.severity = sev;
    incidents.shown = null;
    renderIncidents();
}

// Severity chips are built from what the feed actually classified, with counts,
// including an explicit bucket for unclassified events.
function renderSeverityChips() {
    const wrap = byId('incidentSeverity');
    if (!wrap) return;
    const base = chainIncidents().filter(it =>
        incidents.category === 'all' || it.kind === incidents.category);
    const counts = new Map();
    for (const it of base) {
        const k = severityOf(it).key;
        counts.set(k, (counts.get(k) || 0) + 1);
    }
    clear(wrap);
    const mk = (key, label, count, cssVar) => wrap.appendChild(el('button', {
        class: 'chip', type: 'button',
        'aria-pressed': String(incidents.severity === key),
        onclick: () => setSeverity(key)
    }, [
        cssVar ? (() => {
            const d = el('span', { class: 'chip-dot' });
            d.style.background = Viz.cssVar(cssVar);
            return d;
        })() : null,
        label,
        count != null ? el('span', { class: 'chip-count', text: fmtNum(count) }) : null
    ]));
    mk('all', 'Any', base.length, null);
    for (const key of ['critical', 'major', 'minor', 'none']) {
        if (!counts.get(key)) continue;
        mk(key, SEVERITY_META[key].label, counts.get(key), SEVERITY_META[key].cssVar);
    }
}

function renderIncidents() {
    renderIncidentStats();
    renderSeverityChips();
    renderIncidentHistogram();
    renderIncidentCalendar();
    renderIncidentList();
    renderTabBadge();
}

function renderIncidentStats() {
    const wrap = byId('incidentStats');
    if (!wrap) return;
    const all = chainIncidents();
    const open = all.filter(isOpen);
    const scheduled = all.filter(it => it.kind === 'scheduled');
    const enriched = all.filter(it => enrichmentOf(it)).length;
    clear(wrap);
    wrap.appendChild(statTile({
        label: 'Open now', value: fmtNum(open.length), hero: true,
        sub: `of ${fmtNum(all.length)} retained events`,
        tone: open.length === 0 ? 'good' : 'warn'
    }));
    wrap.appendChild(statTile({
        label: 'Scheduled maintenance', value: fmtNum(scheduled.length),
        sub: 'includes upcoming windows'
    }));
    wrap.appendChild(statTile({
        label: 'Networks named', value: fmtNum(new Set(all.flatMap(it => it.chainIds)).size),
        sub: 'resolved to a registry chain ID'
    }));
    wrap.appendChild(statTile({
        label: 'AI classified', value: all.length ? Viz.fmtPct((enriched / all.length) * 100, 0) : '—',
        sub: `${fmtNum(enriched)} of ${fmtNum(all.length)} events`,
        hint: 'Share of events with an LLM classification from the feed. Unclassified events are never given a guessed severity.'
    }));
}

// Day buckets across the retained window. Labelled as observed event counts,
// not as a metric trend — the feed keeps a rolling window, not history.
function dayBuckets(items) {
    const counts = new Map();
    for (const it of items) {
        const k = dayKey(it.whenMs);
        if (k) counts.set(k, (counts.get(k) || 0) + 1);
    }
    if (!counts.size) return { days: [], counts };
    const keys = [...counts.keys()].sort();
    const start = new Date(`${keys[0]}T00:00:00Z`);
    const end = new Date(`${keys[keys.length - 1]}T00:00:00Z`);
    const days = [];
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
        const k = d.toISOString().slice(0, 10);
        days.push({ key: k, count: counts.get(k) || 0 });
    }
    return { days, counts };
}

function renderIncidentHistogram() {
    const host = byId('incidentHistogram');
    if (!host) return;
    const { days } = dayBuckets(visibleIncidents());
    const res = Viz.dayHistogram(host, {
        days, selected: incidents.dayFilter, valueLabel: 'events',
        tableCaption: 'Retained events per day',
        onSelect: k => {
            incidents.dayFilter = incidents.dayFilter === k ? null : k;
            renderIncidents();
        }
    });
    const actions = byId('incidentHistActions');
    if (actions && res?.table) {
        clear(actions);
        host.appendChild(res.table);
        Viz.attachTableToggle(host, res.table, actions);
    }
}

function renderIncidentCalendar() {
    const host = byId('incidentCalendar');
    if (!host) return;
    const { counts } = dayBuckets(visibleIncidents());
    const res = Viz.calendarHeatmap(host, {
        counts, selected: incidents.dayFilter, noun: 'event',
        onSelect: k => {
            incidents.dayFilter = incidents.dayFilter === k ? null : k;
            renderIncidents();
        }
    });
    const legend = byId('incidentScaleLegend');
    if (legend) Viz.scaleLegend(legend, { max: res?.max, noun: 'events' });
}

// One card builder for chain, coin and provider incidents.
function incidentCard(it) {
    const enr = enrichmentOf(it);
    const sev = severityOf(it);
    const open = isOpen(it);
    const dur = durationInfo(it);
    const when = fmtDateTime(it.whenMs);

    const cls = ['incident-card'];
    if (open) cls.push('is-open');
    else if (it.kind === 'scheduled') cls.push('is-scheduled');

    // Meta line: source, timestamp, and any client/version the operator named.
    const meta = [
        it.isProvider ? it.spName : it.netName,
        when,
        it.urgency === 'urgent' ? 'urgent' : null,
        it.software.length ? it.software.slice(0, 2).join(', ') : null
    ].filter(Boolean);

    const main = el('div', { class: 'incident-main' }, [
        el('div', { class: 'incident-title' }, [
            it.kind === 'scheduled' ? el('span', { class: 'kind-tag', text: 'Scheduled' }) : null,
            el('span', { class: 'incident-title-text' }, [
                it.url
                    ? el('a', { href: it.url, target: '_blank', rel: 'noopener', text: it.title })
                    : el('span', { text: it.title })
            ])
        ]),
        el('div', { class: 'incident-meta', text: meta.join(' · ') })
    ]);

    // ── AI enrichment, fully attributed ──
    if (enr?.summary) {
        const conf = Number.isFinite(enr.confidence) ? enr.confidence : null;
        const head = el('div', { class: 'ai-head' }, [
            el('span', { class: 'ai-tag', text: 'AI' }),
            enr.class ? el('span', { class: 'ai-class', text: String(enr.class).replace(/_/g, ' ') }) : null
        ]);
        if (conf != null) {
            const bar = el('span', { class: 'ai-conf-bar' }, [el('span', { class: 'ai-conf-fill' })]);
            bar.firstChild.style.width = `${Math.round(conf * 100)}%`;
            head.appendChild(el('span', { class: 'ai-conf', title: 'Model-reported confidence in this classification' }, [
                'confidence ', bar, `${Math.round(conf * 100)}%`
            ]));
        }
        if (enr.model) head.appendChild(el('span', { text: `· ${enr.model}` }));

        const block = el('div', { class: 'ai-block' }, [
            head,
            el('div', { class: 'ai-summary', text: enr.summary })
        ]);
        const action = enr.context?.actionRequired;
        if (action && String(action).toLowerCase() !== 'none') {
            block.appendChild(el('div', { class: 'ai-action' }, [
                el('span', { class: 'ai-action-label', text: 'Action:' }),
                el('span', { text: String(action) })
            ]));
        }
        main.appendChild(block);
    } else {
        main.appendChild(el('div', {
            class: 'ai-unclassified',
            text: 'Not classified by the AI pipeline — severity unknown.'
        }));
    }

    // Affected chains: clickable only when resolved to a registry chain ID.
    if (it.chainIds.length) {
        const chips = el('div', { class: 'affected-chains' });
        for (const id of it.chainIds.slice(0, 14)) {
            const c = state.byId.get(id);
            chips.appendChild(el('button', {
                class: 'chain-chip', type: 'button',
                text: c?.name || `Chain ${id}`,
                onclick: e => { e.preventDefault(); e.stopPropagation(); openChainDetail(id); }
            }));
        }
        if (it.chainIds.length > 14) {
            chips.appendChild(el('span', { class: 'legend-count', text: `+${it.chainIds.length - 14} more` }));
        }
        main.appendChild(chips);
    } else if (it.isProvider) {
        main.appendChild(el('div', {
            class: 'incident-meta dim',
            text: it.affectedComponents.length
                ? `Components: ${it.affectedComponents.slice(0, 5).join(', ')}`
                : 'No specific chain named — provider-wide'
        }));
    }

    const side = el('div', { class: 'incident-side' }, [
        el('span', { class: `sev sev-${sev.key}` }, [el('span', { class: 'sev-mark' }), sev.label]),
        it.status ? el('span', { class: 'pill', text: it.status }) : null,
        dur ? el('span', { class: 'incident-dur', title: dur.title, text: dur.text }) : null
    ]);

    return el('div', { class: cls.join(' ') }, [main, side]);
}

function renderIncidentList() {
    const list = byId('incidentsList');
    if (!list) return;
    let items = visibleIncidents();
    if (incidents.dayFilter) items = items.filter(it => dayKey(it.whenMs) === incidents.dayFilter);
    if (searchQuery) {
        items = items.filter(it =>
            it.netName?.toLowerCase().includes(searchQuery)
            || it.title?.toLowerCase().includes(searchQuery)
            || String(it.chainId).includes(searchQuery));
    }

    const countEl = byId('incidentsCount');
    if (countEl) {
        const bits = [`${fmtNum(items.length)} event${items.length === 1 ? '' : 's'}`];
        if (incidents.dayFilter) bits.push(`on ${incidents.dayFilter}`);
        if (incidents.severity !== 'all') bits.push(SEVERITY_META[incidents.severity].label.toLowerCase());
        if (searchQuery) bits.push(`matching “${searchQuery}”`);
        countEl.textContent = bits.join(' · ');
    }

    clear(list);
    if (!items.length) {
        list.appendChild(el('div', {
            class: 'feed-empty',
            text: incidents.items.length ? 'No events match these filters.' : 'Waiting for the live status feed…'
        }));
        return;
    }

    if (incidents.groupBy === 'network') {
        const groups = new Map();
        for (const it of items) {
            if (!groups.has(it.spId)) groups.set(it.spId, []);
            groups.get(it.spId).push(it);
        }
        for (const [, arr] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
            const head = arr[0];
            const openCount = arr.filter(isOpen).length;
            list.appendChild(el('div', { class: 'group-head' }, [
                el('span', { class: 'group-name', text: head.netName }),
                el('span', { class: 'legend-count', text: `${arr.length} event${arr.length === 1 ? '' : 's'}` }),
                openCount ? el('span', { class: 'sev sev-critical' }, [
                    el('span', { class: 'sev-mark' }), `${openCount} open`
                ]) : null
            ]));
            for (const it of arr) list.appendChild(incidentCard(it));
        }
    } else {
        const limit = incidents.shown ?? feedPageSize();
        for (const it of items.slice(0, limit)) list.appendChild(incidentCard(it));
        if (items.length > limit) {
            list.appendChild(feedMoreButton(items.length, limit, () => {
                incidents.shown = limit + feedPageSize() * 2;
                renderIncidentList();
            }));
        }
    }
}

// ═════════════════════════════════════════════════════════════════════════
// Providers view
// ═════════════════════════════════════════════════════════════════════════
function providerIncidents() { return incidents.items.filter(it => it.isProvider); }
function visibleProviderIncidents() {
    const all = providerIncidents();
    return providers.filter === 'all' ? all : all.filter(it => it.spId === providers.filter);
}
function providerMatchesSearch(it, q) {
    if (it.spName?.toLowerCase().includes(q) || it.title?.toLowerCase().includes(q)) return true;
    if ((it.affectedComponents || []).some(c => c.toLowerCase().includes(q))) return true;
    return it.chainIds.some(id => String(id).includes(q) || state.byId.get(id)?.name?.toLowerCase().includes(q));
}

function initProviderControls() { /* chips are generated in renderProviderFilter */ }

function renderProviders() {
    renderProviderStats();
    renderProviderFilter();
    renderProviderHistogram();
    renderProviderCalendar();
    renderProviderList();
}

function renderProviderStats() {
    const wrap = byId('providerStats');
    if (!wrap) return;
    const all = providerIncidents();
    const open = all.filter(isOpen);
    const affected = new Set(open.flatMap(it => it.chainIds));
    clear(wrap);
    wrap.appendChild(statTile({
        label: 'Open provider incidents', value: fmtNum(open.length), hero: true,
        sub: `of ${fmtNum(all.length)} retained events`,
        tone: open.length === 0 ? 'good' : 'warn'
    }));
    wrap.appendChild(statTile({
        label: 'Providers tracked', value: fmtNum(new Set(all.map(it => it.spId)).size),
        sub: 'with at least one retained event'
    }));
    wrap.appendChild(statTile({
        label: 'Networks affected now', value: fmtNum(affected.size),
        sub: 'named by an open provider incident',
        tone: affected.size ? 'warn' : 'good'
    }));
    wrap.appendChild(statTile({
        label: 'Events naming a chain', value: all.length
            ? Viz.fmtPct((all.filter(it => it.chainIds.length).length / all.length) * 100, 0) : '—',
        sub: 'the rest are provider-wide',
        hint: 'Providers often report an incident without naming a specific chain, so fan-out coverage is partial by nature.'
    }));
}

function renderProviderFilter() {
    const bar = byId('providerFilter');
    if (!bar) return;
    const all = providerIncidents();
    const counts = new Map(), names = new Map(), openCounts = new Map();
    for (const it of all) {
        counts.set(it.spId, (counts.get(it.spId) || 0) + 1);
        if (!names.has(it.spId)) names.set(it.spId, it.spName);
        if (isOpen(it)) openCounts.set(it.spId, (openCounts.get(it.spId) || 0) + 1);
    }
    clear(bar);
    const mk = (id, label, count, openN) => bar.appendChild(el('button', {
        class: 'chip', type: 'button', 'data-prov': id,
        'aria-pressed': String(providers.filter === id),
        onclick: () => { providers.filter = id; providers.shown = null; renderProviders(); }
    }, [
        label,
        count != null ? el('span', { class: 'chip-count', text: fmtNum(count) }) : null,
        openN ? el('span', { class: 'chip-dot', style: 'background: var(--critical)' }) : null
    ]));
    mk('all', 'All', all.length, all.filter(isOpen).length);
    for (const [id, name] of [...names].sort((a, b) => (a[1] || '').localeCompare(b[1] || ''))) {
        mk(id, name, counts.get(id) || 0, openCounts.get(id) || 0);
    }
}

function renderProviderHistogram() {
    const host = byId('providerHistogram');
    if (!host) return;
    const { days } = dayBuckets(visibleProviderIncidents());
    const res = Viz.dayHistogram(host, {
        days, selected: providers.dayFilter, valueLabel: 'events',
        tableCaption: 'Retained provider events per day',
        onSelect: k => {
            providers.dayFilter = providers.dayFilter === k ? null : k;
            renderProviders();
        }
    });
    const actions = byId('providerHistActions');
    if (actions && res?.table) {
        clear(actions);
        host.appendChild(res.table);
        Viz.attachTableToggle(host, res.table, actions);
    }
}

function renderProviderCalendar() {
    const host = byId('providerCalendar');
    if (!host) return;
    const { counts } = dayBuckets(visibleProviderIncidents());
    const res = Viz.calendarHeatmap(host, {
        counts, selected: providers.dayFilter, noun: 'event',
        onSelect: k => {
            providers.dayFilter = providers.dayFilter === k ? null : k;
            renderProviders();
        }
    });
    const legend = byId('providerScaleLegend');
    if (legend) Viz.scaleLegend(legend, { max: res?.max, noun: 'events' });
}

function renderProviderList() {
    const list = byId('providersList');
    if (!list) return;
    let items = visibleProviderIncidents();
    if (providers.dayFilter) items = items.filter(it => dayKey(it.whenMs) === providers.dayFilter);
    if (searchQuery) items = items.filter(it => providerMatchesSearch(it, searchQuery));

    const countEl = byId('providersCount');
    if (countEl) {
        const bits = [`${fmtNum(items.length)} event${items.length === 1 ? '' : 's'}`];
        if (providers.dayFilter) bits.push(`on ${providers.dayFilter}`);
        if (searchQuery) bits.push(`matching “${searchQuery}”`);
        countEl.textContent = bits.join(' · ');
    }

    clear(list);
    if (!items.length) {
        list.appendChild(el('div', {
            class: 'feed-empty',
            text: providerIncidents().length ? 'No events match these filters.' : 'Waiting for the live status feed…'
        }));
        return;
    }
    const limit = providers.shown ?? feedPageSize();
    for (const it of items.slice(0, limit)) list.appendChild(incidentCard(it));
    if (items.length > limit) {
        list.appendChild(feedMoreButton(items.length, limit, () => {
            providers.shown = limit + feedPageSize() * 2;
            renderProviderList();
        }));
    }
}

// ═════════════════════════════════════════════════════════════════════════
// Forum activity
//
// Tile area = post volume in the retained window. Tile colour = a DIVERGING
// ramp on weekly momentum (warm = more posts this week than last, cool = fewer,
// neutral gray in the middle). The previous red/green pairing was the worst
// possible choice for colour-vision deficiency.
//
// Momentum honesty: a forum with no prior-week posts has no ratio to report, so
// it renders neutral and says "no prior week to compare" rather than being
// painted maximally hot, which is what the old (recent-prior)/prior formula did
// for every brand-new forum.
// ═════════════════════════════════════════════════════════════════════════
const forum = {
    threads: new Map(), byForum: new Map(), loaded: false, loading: false,
    filter: null, ws: null, retries: 0, rerenderTimer: null,
    // null = this breakpoint's default number of forum groups to list.
    groupsShown: null
};
const FORUM_TREEMAP_HEIGHT = 440;

function forumThreadKey(u) {
    try { const x = new URL(u); return x.origin + x.pathname; } catch { return u; }
}

function ensureForumView() {
    if (forum.loaded) { renderForumTreemap(); return; }
    if (forum.loading) return;
    forum.loading = true;
    setForumLive(false);
    loadForumFeed();
}
function setForumLive(live) { setLiveDot('forumMeta', live); }

async function loadForumFeed() {
    try {
        const res = await fetch(`${FORUM_NEWS_BASE}/news?limit=500`, { headers: { accept: 'application/json' } });
        if (!res.ok) throw new Error(String(res.status));
        for (const p of (await res.json()).news || []) upsertForumPost(p);
        regroupForum();
        forum.loaded = true;
    } catch {
        const list = byId('forumList');
        if (list) {
            clear(list);
            list.appendChild(el('div', { class: 'feed-empty', text: 'Forum feed unavailable (chains-forum-news).' }));
        }
        return;
    } finally {
        forum.loading = false;
    }
    renderForumTreemap();
    renderForumList();
    connectForumFeed();
}

function connectForumFeed() {
    setForumLive(false);
    const wsUrl = `${FORUM_NEWS_BASE.replace(/^http/, 'ws')}/ws?replay=1`;
    let ws;
    try { ws = new WebSocket(wsUrl); } catch { return; }
    forum.ws = ws;
    ws.onopen = () => { forum.retries = 0; setForumLive(true); };
    ws.onmessage = ev => {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'news.item' && m.item && upsertForumPost(m.item)) scheduleForumRerender();
    };
    ws.onerror = () => { try { ws.close(); } catch { /* noop */ } };
    ws.onclose = () => {
        forum.ws = null;
        setForumLive(false);
        if (forum.retries < 6) {
            const delay = Math.min(1000 * 2 ** forum.retries, 20000);
            forum.retries++;
            setTimeout(connectForumFeed, delay);
        }
    };
}

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
        if (!map.has(p.forumId)) {
            map.set(p.forumId, {
                id: p.forumId, name: p.forumName, chainMap: new Map(),
                posts: [], recent: 0, prior: 0
            });
        }
        const g = map.get(p.forumId);
        g.posts.push(p);
        for (const c of p.chains) if (!g.chainMap.has(c.chainId)) g.chainMap.set(c.chainId, c);
        if (p.whenMs != null) {
            const age = now - p.whenMs;
            if (age >= 0 && age < WEEK) g.recent++;
            else if (age >= WEEK && age < 2 * WEEK) g.prior++;
        }
    }
    for (const g of map.values()) {
        g.chains = [...g.chainMap.values()];
        if (g.prior > 0) {
            // Keep the true ratio for the label and a clamped copy for the
            // colour ramp — reporting the clamped value would understate a
            // forum that went from 2 posts to 20 as merely "+100%".
            g.momentumRaw = (g.recent - g.prior) / g.prior;
            g.momentum = Math.max(-1, Math.min(1, g.momentumRaw));
            g.comparable = true;
        } else {
            // No baseline — say so instead of reporting +100%.
            g.momentumRaw = null;
            g.momentum = 0;
            g.comparable = false;
        }
    }
    return new Map([...map.entries()].sort((a, b) => b[1].posts.length - a[1].posts.length));
}

function forumMatchesSearch(p, q) {
    if (p.title.toLowerCase().includes(q) || p.forumName.toLowerCase().includes(q)) return true;
    return p.chains.some(c => String(c.chainId).includes(q) || (c.name || '').toLowerCase().includes(q));
}

function momentumText(g) {
    if (!g || !g.comparable || g.momentumRaw == null) return 'no prior week to compare';
    if (Math.abs(g.momentumRaw) <= 0.05) return 'flat week on week';
    const pct = Math.round(g.momentumRaw * 100);
    return `${pct > 0 ? '+' : ''}${pct}% vs last week (${g.recent} this week, ${g.prior} last)`;
}

function renderForumTreemap() {
    const host = byId('forumTreemap');
    if (!host) return;
    if (!forum.byForum.size) {
        host.style.height = 'auto';
        clear(host);
        host.appendChild(el('div', { class: 'chart-empty', text: forum.loaded ? 'No forum activity retained.' : 'Loading forum activity…' }));
        return;
    }

    // Size by the posts matching the active search, so every visible tile has
    // clickable posts and the list below stays in lockstep.
    const nodes = [...forum.byForum.values()]
        .map(g => ({
            id: g.id,
            label: g.chains[0]?.name || g.name,
            value: searchQuery ? g.posts.filter(p => forumMatchesSearch(p, searchQuery)).length : g.posts.length,
            // null (not 0) when there is no baseline, so the tile renders
            // neutral AND the label can distinguish "flat" from "unknown".
            signal: g.comparable ? g.momentum : null,
            signalLabel: momentumText(g),
            note: `${g.recent} this week · ${g.prior} the week before`,
            g
        }))
        .filter(n => n.value > 0);

    const focusIds = searchQuery ? new Set(nodes.map(n => n.id)) : null;
    // 27 tiles in a 324px-wide box produces unlabelled slivers. On a phone show
    // the busiest forums only, taller, and say so — the full list stays in the
    // table twin and in the grouped posts below.
    const narrow = isNarrow();
    const ranked = nodes.slice().sort((a, b) => b.value - a.value);
    const shownNodes = narrow ? ranked.slice(0, 10) : nodes;
    const hiddenCount = nodes.length - shownNodes.length;
    const res = Viz.treemap(host, {
        nodes: shownNodes,
        height: narrow ? 380 : FORUM_TREEMAP_HEIGHT,
        selectedId: forum.filter, focusIds,
        valueFmt: n => `${fmtNum(n)} post${n === 1 ? '' : 's'}`,
        // A forum with no prior-week posts has no ratio to report — say that
        // rather than printing "flat", which would imply a real comparison.
        signalFmt: s => {
            if (!Number.isFinite(s)) return 'no prior week to compare';
            if (Math.abs(s) <= 0.05) return 'flat week on week';
            const p = Math.round(s * 100);
            return `${p > 0 ? '+' : ''}${p}% vs last week`;
        },
        tableCaption: 'Forum post volume and weekly momentum',
        onSelect: id => {
            forum.filter = forum.filter === id ? null : id;
            forum.groupsShown = null;
            renderForumTreemap();
            renderForumList();
        }
    });

    // Diverging scale legend, built from the diverging tokens.
    const legend = byId('forumScaleLegend');
    if (legend) {
        clear(legend);
        const cool = Viz.cssVar('--div-cool'), warm = Viz.cssVar('--div-warm'), mid = Viz.cssVar('--div-mid');
        const ramp = el('div', { class: 'scale-ramp' });
        for (const c of [Viz.mix(mid, cool, 1), Viz.mix(mid, cool, 0.6), Viz.mix(mid, cool, 0.3),
            mid, Viz.mix(mid, warm, 0.3), Viz.mix(mid, warm, 0.6), Viz.mix(mid, warm, 1)]) {
            const s = el('span', { class: 'scale-step' });
            s.style.background = c;
            ramp.appendChild(s);
        }
        legend.appendChild(el('span', { text: 'fewer posts than last week' }));
        legend.appendChild(ramp);
        legend.appendChild(el('span', { text: 'more posts than last week' }));
    }

    const note = byId('forumNote');
    if (note) {
        const noBase = [...forum.byForum.values()].filter(g => !g.comparable).length;
        note.textContent = `${fmtNum(forum.byForum.size)} forums across ${fmtNum(forum.threads.size)} retained threads. `
            + (hiddenCount > 0 ? `Showing the ${fmtNum(shownNodes.length)} busiest here; ${fmtNum(hiddenCount)} smaller forums are in the table and the list below. ` : '')
            + (noBase ? `${fmtNum(noBase)} forums had no posts in the prior week, so they have no momentum baseline and render neutral. ` : '')
            + 'Momentum compares this week\'s post count with last week\'s within the feed\'s retained window — it is not a long-run trend.';
    }

    const actions = byId('forumActions');
    if (actions && res?.table) {
        clear(actions);
        // The treemap's table twin lives in the card, not inside the treemap
        // div, so it survives the container clear — drop the previous one or
        // every re-render (search, resize, live post) stacks another copy.
        host.parentNode.querySelectorAll(':scope > .chart-table').forEach(t => t.remove());
        host.parentNode.appendChild(res.table);
        Viz.attachTableToggle(host, res.table, actions);
    }
}

function renderForumList() {
    const list = byId('forumList');
    if (!list) return;
    if (!forum.loaded) return;
    const groups = [...forum.byForum.values()]
        .filter(g => !forum.filter || g.id === forum.filter)
        .map(g => ({ g, posts: g.posts.filter(p => !searchQuery || forumMatchesSearch(p, searchQuery)) }))
        .filter(x => x.posts.length)
        .sort((a, b) => (b.posts[0]?.whenMs || 0) - (a.posts[0]?.whenMs || 0));

    // Every forum group with its posts made this the tallest view on a phone.
    // Page the GROUPS as well as the posts within each one.
    const groupLimit = forum.groupsShown ?? (isNarrow() ? 5 : 10);
    const visibleGroups = groups.slice(0, groupLimit);

    let shown = 0;
    clear(list);
    for (const { g, posts } of visibleGroups) {
        shown += posts.length;
        const chips = el('div', { class: 'affected-chains' }, g.chains.slice(0, 6).map(c =>
            el('button', {
                class: 'chain-chip', type: 'button',
                text: c.name || `Chain ${c.chainId}`,
                onclick: () => openChainDetail(c.chainId)
            })));
        list.appendChild(el('div', { class: 'group-head' }, [
            el('span', { class: 'group-name', text: g.name }),
            el('span', { class: 'legend-count', text: `${posts.length} post${posts.length === 1 ? '' : 's'}` }),
            el('span', { class: 'legend-count', text: momentumText(g) }),
            chips
        ]));
        for (const p of posts.slice(0, isNarrow() ? 5 : 20)) {
            list.appendChild(el('div', { class: 'incident-card' }, [
                el('div', { class: 'incident-main' }, [
                    el('div', { class: 'incident-title' }, [
                        el('span', { class: 'incident-title-text' }, [
                            el('a', { href: p.url, target: '_blank', rel: 'noopener', text: p.title })
                        ])
                    ]),
                    el('div', {
                        class: 'incident-meta',
                        text: [p.forumName, p.whenMs ? relTime(new Date(p.whenMs).toISOString()) : null]
                            .filter(Boolean).join(' · ')
                    })
                ])
            ]));
        }
    }
    if (groups.length > visibleGroups.length) {
        list.appendChild(el('div', { class: 'table-foot' }, [
            el('button', {
                class: 'btn', type: 'button',
                text: `Show more forums — ${fmtNum(groups.length - visibleGroups.length)} remaining`,
                onclick: () => { forum.groupsShown = groupLimit + 10; renderForumList(); }
            })
        ]));
    }

    const count = byId('forumCount');
    if (count) {
        count.textContent = `${fmtNum(shown)} post${shown === 1 ? '' : 's'}`
            + (forum.filter ? ` · ${forum.byForum.get(forum.filter)?.name || ''}` : '')
            + (searchQuery ? ` · matching “${searchQuery}”` : '');
    }
    if (!shown) list.appendChild(el('div', { class: 'feed-empty', text: 'No posts match these filters.' }));
}

// ═════════════════════════════════════════════════════════════════════════
// Chain detail drawer
// ═════════════════════════════════════════════════════════════════════════
function initDrawer() {
    byId('closeDrawer')?.addEventListener('click', () => closeDrawer());
    byId('drawerScrim')?.addEventListener('click', () => closeDrawer());
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !byId('detailDrawer')?.classList.contains('hidden')) closeDrawer();
    });
}
function closeDrawer(opts = {}) {
    byId('detailDrawer')?.classList.add('hidden');
    stopBlockHead();
    openChainId = null;
    if (!opts.fromUrl) updateUrl();
}
function chainLink(id) {
    const c = state.byId.get(id);
    return el('button', {
        class: 'chip-link', type: 'button',
        text: c?.name || `Chain ${id}`,
        onclick: () => openChainDetail(id)
    });
}
function detailRow(label, valueNode) {
    return el('div', { class: 'd-row' }, [
        el('span', { class: 'd-label', text: label }),
        el('div', { class: 'd-value' }, [].concat(valueNode))
    ]);
}
function drawerSection(title) {
    return el('div', { class: 'd-section' }, [el('div', { class: 'd-section-title', text: title })]);
}

function openChainDetail(chainId, opts = {}) {
    const c = state.byId.get(chainId);
    if (!c) return;
    openChainId = chainId;
    if (!opts.fromUrl) updateUrl();

    const body = byId('drawerBody');
    const cls = netClass(c);
    const e = state.rel.get(chainId) || {};
    const l2b = state.l2beat.get(chainId);
    const sp = state.statusPagesByChain.get(chainId);
    const open = state.openByChain.get(chainId) || [];
    clear(body);

    // ── header ──
    const badges = el('div', { class: 'd-badges' }, [
        el('span', { class: 'badge', text: `ID ${c.chainId}` }),
        typeTag(cls),
        el('span', { class: `pill pill-${statusOf(c)}`, text: statusOf(c) }),
        ...classTags(c).map(t => el('span', { class: 'tag', text: t }))
    ]);
    body.appendChild(el('div', { class: 'd-header' }, [
        el('div', {}, [
            el('h2', { id: 'drawerTitle', text: c.name || `Chain ${c.chainId}` }),
            badges
        ])
    ]));

    // ── open incidents first: it is the most urgent thing to know ──
    if (open.length) {
        const sec = drawerSection(`Open incidents (${open.length})`);
        for (const it of open.slice(0, 5)) {
            const sev = severityOf(it);
            const dur = durationInfo(it);
            sec.appendChild(el('div', { class: 'incident-card is-open' }, [
                el('div', { class: 'incident-main' }, [
                    el('div', { class: 'incident-title' }, [
                        el('span', { class: 'incident-title-text' }, [
                            it.url ? el('a', { href: it.url, target: '_blank', rel: 'noopener', text: it.title })
                                : el('span', { text: it.title })
                        ])
                    ]),
                    el('div', {
                        class: 'incident-meta',
                        text: [it.isProvider ? `${it.spName} (RPC provider)` : it.spName,
                            it.status, dur?.text].filter(Boolean).join(' · ')
                    })
                ]),
                el('div', { class: 'incident-side' }, [
                    el('span', { class: `sev sev-${sev.key}` }, [el('span', { class: 'sev-mark' }), sev.label])
                ])
            ]));
        }
        body.appendChild(sec);
    }

    // ── relationships ──
    const relSec = drawerSection('Relationships');
    let hasRel = false;
    if (e.l1Parent != null) { relSec.appendChild(detailRow('Settles on', chainLink(e.l1Parent))); hasRel = true; }
    if (e.mainnet != null) { relSec.appendChild(detailRow('Testnet of', chainLink(e.mainnet))); hasRel = true; }
    if (e.l2Children?.length) {
        relSec.appendChild(detailRow(`L2s / L3s (${e.l2Children.length})`, e.l2Children.slice(0, 30).map(chainLink)));
        hasRel = true;
    }
    if (e.testnetChildren?.length) {
        relSec.appendChild(detailRow(`Testnets (${e.testnetChildren.length})`, e.testnetChildren.slice(0, 30).map(chainLink)));
        hasRel = true;
    }
    if (!hasRel) relSec.appendChild(detailRow('Related chains', el('span', { class: 'dim', text: 'None recorded' })));
    body.appendChild(relSec);

    // ── L2BEAT ──
    if (l2b) {
        const sec = drawerSection('L2BEAT classification');
        sec.appendChild(detailRow('Value secured', el('span', { class: 'strong', text: fmtUsd(l2b.tvs) })));
        sec.appendChild(detailRow('Stage', l2b.stage
            ? el('span', { class: 'pill pill-stage', text: l2b.stage })
            : el('span', { class: 'dim', text: '—' })));
        if (l2b.category) sec.appendChild(detailRow('Category', el('span', { text: l2b.category })));
        if (l2b.stack) sec.appendChild(detailRow('Stack', el('span', { text: l2b.stack })));
        if (l2b.daLayer) sec.appendChild(detailRow('Data availability', el('span', { text: l2b.daLayer })));
        body.appendChild(sec);
    }

    // ── registry detail (fetched) ──
    const infoSec = drawerSection('Network detail');
    const extraBox = el('div');
    infoSec.appendChild(extraBox);
    if (sp) {
        infoSec.appendChild(detailRow('Status page',
            el('a', { href: sp.url, target: '_blank', rel: 'noopener', text: safeHost(sp.url) || sp.name })));
    }
    body.appendChild(infoSec);

    // ── live RPC ──
    const rpcSec = drawerSection('RPC endpoints');
    const headCell = el('span', { class: 'mono', text: '…' });
    rpcSec.appendChild(detailRow('Block head', headCell));
    const rpcBox = el('div', { class: 'rpc-list' }, [
        el('span', { class: 'dim', text: 'Probing endpoints…' })
    ]);
    rpcSec.appendChild(detailRow('Reachable', rpcBox));
    const clientBox = el('div', { class: 'd-value dim', text: '—' });
    rpcSec.appendChild(detailRow('Clients (live)', clientBox));
    body.appendChild(rpcSec);

    // ── forum ──
    const forumBox = el('div', { class: 'rpc-list' });
    const forumSec = drawerSection('Recent forum posts');
    forumSec.appendChild(forumBox);
    forumSec.classList.add('hidden');
    body.appendChild(forumSec);

    byId('detailDrawer').classList.remove('hidden');
    byId('closeDrawer')?.focus();

    loadChainDetail(chainId, extraBox);
    loadForumNews(chainId, forumBox, forumSec);
    loadLiveRpc(chainId, rpcBox, headCell);
    loadLiveClients(chainId, clientBox);
}

// /summary is slim, so currency/explorers/website need the full chain record.
async function loadChainDetail(chainId, box) {
    let d = state.byId.get(chainId) || {};
    if (!d.nativeCurrency && !d.explorers && !d.infoURL) {
        try { d = await api(`/chains/${chainId}`); } catch { /* render what we have */ }
    }
    if (openChainId !== chainId) return;
    clear(box);
    if (d.nativeCurrency) {
        const cur = `${d.nativeCurrency.name || d.nativeCurrency.symbol} (${d.nativeCurrency.symbol})`;
        box.appendChild(detailRow('Native currency', el('span', { text: cur })));
    }
    // Price exists for only ~32 chains and rollups are mapped to their L1's
    // token, so label it as the token price rather than implying a chain metric.
    if (typeof d.price?.usd === 'number') {
        box.appendChild(detailRow('Token price', el('span', {
            title: `Source: CoinGecko, cached. Read ${relTime(d.price.updatedAt)}. Rollups are mapped to their settlement token.`,
            text: `$${d.price.usd.toLocaleString()} · ${relTime(d.price.updatedAt)}`
        })));
    }
    if (d.explorers?.length) {
        box.appendChild(detailRow('Explorers', d.explorers.slice(0, 6).map(x =>
            el('a', { href: x.url, target: '_blank', rel: 'noopener', text: x.name || safeHost(x.url) }))));
    }
    if (d.infoURL) {
        box.appendChild(detailRow('Website',
            el('a', { href: d.infoURL, target: '_blank', rel: 'noopener', text: safeHost(d.infoURL) || d.infoURL })));
    }
    if (d.forumUrl) {
        box.appendChild(detailRow('Forum',
            el('a', { href: d.forumUrl, target: '_blank', rel: 'noopener', text: safeHost(d.forumUrl) || d.forumUrl })));
    }
    if (d.slip44 != null) box.appendChild(detailRow('SLIP-44', el('span', { class: 'mono', text: String(d.slip44) })));
    if (d.statusReason) box.appendChild(detailRow('Status note', el('span', { class: 'dim', text: d.statusReason })));
}

async function loadForumNews(chainId, box, section) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
        const res = await fetch(`${FORUM_NEWS_BASE}/news?chainId=${chainId}&limit=4`, {
            headers: { accept: 'application/json' }, signal: ctrl.signal
        });
        if (!res.ok) return;
        let posts = (await res.json()).news || [];
        posts = [...new Map(posts.map(p => [forumThreadKey(p.url), p])).values()].slice(0, 4);
        if (openChainId !== chainId || !posts.length) return;
        clear(box);
        for (const p of posts) {
            box.appendChild(el('div', { class: 'forum-post' }, [
                el('a', { href: p.url, target: '_blank', rel: 'noopener', text: p.title }),
                el('span', { class: 'forum-when', text: relTime(p.publishedAt) })
            ]));
        }
        section.classList.remove('hidden');
    } catch { /* section stays hidden */ }
    finally { clearTimeout(timer); }
}

function clientNameVersion(cv) {
    if (!cv) return null;
    return String(cv).split('/').slice(0, 2).join(' ').trim() || null;
}

async function loadLiveRpc(chainId, box, headCell) {
    stopBlockHead();
    const usable = urls => urls
        .map(u => typeof u === 'string' ? u : u?.url)
        .filter(u => u && u.startsWith('http') && !u.includes('${'));
    let staticUrls = usable(state.byId.get(chainId)?.rpc || []);
    let results = [];

    const [healthRes, endpointsRes] = await Promise.allSettled([
        api(`/rpc-monitor/${chainId}`),
        staticUrls.length || !state.byId.get(chainId)?.rpcCount
            ? Promise.resolve(null)
            : api(`/endpoints/${chainId}`)
    ]);
    if (healthRes.status === 'fulfilled') {
        const d = healthRes.value;
        results = d.endpoints || d.results || (Array.isArray(d) ? d : []);
    }
    if (endpointsRes.status === 'fulfilled' && endpointsRes.value) {
        staticUrls = usable(endpointsRes.value.rpc || []);
    }
    if (openChainId !== chainId) return;

    const working = results.filter(r => r.status === 'working' || r.ok === true);
    const failed = results.filter(r => r.status === 'failed');
    clear(box);

    if (working.length) {
        for (const r of working.slice(0, 12)) {
            const ver = clientNameVersion(r.clientVersion);
            box.appendChild(el('div', { class: 'rpc-row' }, [
                el('span', { class: 'dot dot-ok' }),
                el('span', { class: 'rpc-host', text: safeHost(r.url) || r.url, title: r.url }),
                ver ? el('span', { class: 'rpc-meta', text: ver }) : null
            ]));
        }
    }
    // Failures were previously discarded entirely. Reporting the count (and why)
    // is the difference between "no endpoints" and "we probed and they failed".
    if (failed.length) {
        const reasons = [...new Set(failed.map(r => r.error).filter(Boolean))].slice(0, 2);
        box.appendChild(el('div', { class: 'rpc-row' }, [
            el('span', { class: 'dot dot-bad' }),
            el('span', {
                class: 'dim',
                text: `${failed.length} of ${results.length} probed endpoint${results.length === 1 ? '' : 's'} failed`
                    + (reasons.length ? ` — ${reasons.join('; ')}` : '')
            })
        ]));
    }
    if (!results.length) {
        box.appendChild(el('span', {
            class: 'dim',
            text: staticUrls.length
                ? `${staticUrls.length} endpoint${staticUrls.length === 1 ? '' : 's'} in the registry, not yet probed`
                : 'No endpoints in the registry.'
        }));
    }
    const total = state.byId.get(chainId)?.rpcCount || 0;
    if (results.length && total > results.length) {
        box.appendChild(el('span', {
            class: 'dim',
            text: `The monitor samples up to 5 endpoints per chain; the registry lists ${total}.`
        }));
    }

    const candidates = [...new Set([...working.map(r => r.url), ...staticUrls])];
    if (candidates.length) startBlockHead(candidates, headCell);
    else headCell.textContent = '—';
}

async function loadLiveClients(chainId, box) {
    try {
        const d = await api(`/clients/${chainId}`);
        if (openChainId !== chainId) return;
        const clients = d.clients || [];
        if (!clients.length) { box.textContent = 'No client data yet.'; return; }
        clear(box);
        box.classList.remove('dim');
        for (const cl of clients) {
            const vers = cl.versions || [];
            const breakdown = vers.map(x => `${x.version}${x.nodeCount ? ` ×${x.nodeCount}` : ''}`).join(' · ');
            const children = [cl.name];
            // Only inline a version when there is exactly one — otherwise the
            // pill would pair one node's version with the whole client's count.
            if (vers.length === 1) {
                children.push(' ', el('span', { class: 'client-ver', text: vers[0].version }));
                if (cl.nodeCount) children.push(` ×${cl.nodeCount}`);
            } else {
                if (cl.nodeCount) children.push(` ×${cl.nodeCount}`);
                if (breakdown) children.push(' ', el('span', { class: 'client-ver', text: `(${breakdown})` }));
            }
            box.appendChild(el('span', { class: 'client-pill', title: breakdown }, children));
        }
    } catch { box.textContent = '—'; }
}

// ─── client-side block-head polling ──────────────────────────────────────
let blockHeadTimer = null;
let blockHeadToken = 0;
function stopBlockHead() {
    if (blockHeadTimer) { clearInterval(blockHeadTimer); blockHeadTimer = null; }
}
async function rpcBlockNumber(url) {
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] })
        });
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
            if (token !== blockHeadToken) return;
            if (n != null) {
                liveUrl = u;
                cell.textContent = `#${n.toLocaleString()}`;
                cell.title = `Polled directly from your browser via ${safeHost(u) || u}`;
                return;
            }
        }
        if (token === blockHeadToken && !liveUrl) cell.textContent = 'unreachable from this browser';
    };
    poll();
    blockHeadTimer = setInterval(poll, 5000);
}

// ═════════════════════════════════════════════════════════════════════════
// Assistant
//
// The anti-hallucination design here is provenance, not cleverness: the model
// only reaches data through this API's own tools, and every reply shows which
// tools produced it plus one-tap links to the chains those calls touched. A
// claim you cannot trace to a tool call is a claim to distrust — and the panel
// says so in its own lead text.
//
// Conversation lives in memory only: the URL would leak chat text into
// shareable links, and localStorage would resurrect stale conversations on a
// public dashboard.
// ═════════════════════════════════════════════════════════════════════════
const assistant = { messages: [], busy: false, enabled: null, disabledNoticeShown: false };

function initAssistant() {
    byId('assistantFab')?.addEventListener('click', () => toggleAssistant());
    byId('assistantClose')?.addEventListener('click', () => toggleAssistant(false));
    byId('assistantNew')?.addEventListener('click', () => resetAssistantChat());
    byId('assistantForm')?.addEventListener('submit', e => { e.preventDefault(); submitAssistantInput(); });
    byId('assistantInput')?.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitAssistantInput(); }
    });
    document.querySelectorAll('#assistantChips .chat-chip').forEach(chip =>
        chip.addEventListener('click', () => sendAssistantMessage(chip.textContent)));
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !byId('assistantOverlay')?.classList.contains('hidden')) toggleAssistant(false);
    });
}

function toggleAssistant(open) {
    const overlay = byId('assistantOverlay');
    if (!overlay) return;
    const show = open ?? overlay.classList.contains('hidden');
    overlay.classList.toggle('hidden', !show);
    byId('assistantFab')?.setAttribute('aria-expanded', String(show));
    if (show) {
        probeAssistant();
        if (assistant.enabled !== false) byId('assistantInput')?.focus();
    }
}

async function probeAssistant() {
    const meta = byId('assistantMeta');
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
        meta.className = 'pill-meta';
        meta.style.color = online ? Viz.cssVar('--good') : Viz.cssVar('--critical');
    }
    if (!assistant.enabled && !assistant.disabledNoticeShown) {
        assistant.disabledNoticeShown = true;
        appendChatNotice('The assistant is not configured on this server (no language model connected). Everything else on the dashboard works as usual.');
        setAssistantBusy(true);
    }
}

function submitAssistantInput() {
    const input = byId('assistantInput');
    const text = (input?.value || '').trim();
    if (!text) return;
    input.value = '';
    sendAssistantMessage(text);
}

async function sendAssistantMessage(text) {
    if (assistant.busy || assistant.enabled === false) return;
    byId('assistantChips')?.classList.add('hidden');
    assistant.messages.push({ role: 'user', content: text.slice(0, 4000) });
    if (assistant.messages.length > 20) assistant.messages = assistant.messages.slice(-20);
    appendChatBubble('user', text);
    setAssistantBusy(true);
    const thinking = appendChatThinking();
    try {
        const context = { view: activeView, ...(openChainId != null ? { chainId: openChainId } : {}) };
        let res = await apiPost('/assistant/chat', { messages: assistant.messages, context });
        // Slow runs return 202 + a job id; poll so a reverse-proxy timeout can
        // never kill a long-held request.
        if (res.status === 202 && res.data?.jobId) {
            thinking.setSteps(assistantStepsFrom(res.data));
            res = await pollAssistantJob(res.data.jobId, res.data.pollAfterMs, res.data.budgetMs, thinking.setSteps);
        }
        thinking.remove();
        if (res.ok && res.data?.reply != null) {
            assistant.messages.push({ role: 'assistant', content: res.data.reply });
            appendChatBubble('assistant', res.data.reply, {
                toolCalls: res.data.toolCalls,
                degraded: res.data.degraded,
                viaFallback: res.data.viaFallback
            });
        } else if (res.status === 429) {
            appendChatNotice('Too many questions in a short window. Try again in a minute.');
        } else if (res.status === 503) {
            const msg = res.data?.error || '';
            appendChatNotice(
                msg === 'Assistant not configured' ? 'The assistant is not configured on this server.'
                    : msg === 'Assistant LLM unreachable' || msg === 'Assistant failed'
                        ? 'The assistant\'s language model is unreachable right now. Try again shortly.'
                        : msg || 'The assistant is unavailable right now.');
        } else {
            appendChatNotice(res.data?.error || 'Something went wrong. Please try again.');
        }
    } catch {
        thinking.remove();
        appendChatNotice('Network error — the request did not reach the server.');
    } finally {
        setAssistantBusy(assistant.enabled === false);
        byId('assistantInput')?.focus();
    }
}

async function pollAssistantJob(jobId, pollAfterMs, budgetMs, onStep = () => { }) {
    const windowMs = Math.min((budgetMs || 4 * 60 * 1000) + 60 * 1000, 15 * 60 * 1000);
    const deadline = Date.now() + windowMs;
    const delay = Math.max(1000, pollAfterMs || 2000);
    let consecutiveMisses = 0;
    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, delay));
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15000);
        let res, data;
        try {
            res = await fetch(`${API_BASE}/assistant/chat/${jobId}`, {
                headers: { accept: 'application/json' }, signal: ctrl.signal
            });
            data = res.ok ? await res.json().catch(() => null) : null;
        } catch { continue; }
        finally { clearTimeout(timer); }

        if (res.status === 404) {
            // Jobs live in one replica's memory, so behind a round-robin load
            // balancer a poll routinely lands on a pod that never saw this job.
            // Only a long unbroken run of misses means it is really gone.
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
        const node = byId(id);
        if (node) node.disabled = busy;
    }
}

function resetAssistantChat() {
    if (assistant.busy) return;
    assistant.messages = [];
    clear(byId('assistantLog'));
    byId('assistantChips')?.classList.remove('hidden');
    byId('assistantInput')?.focus();
}

function appendChatBubble(role, text, { toolCalls, degraded, viaFallback } = {}) {
    const log = byId('assistantLog');
    const body = el('div', { class: 'chat-bubble-body' });
    body.innerHTML = renderAssistantMarkdown(text);
    const extras = [];

    if (role === 'assistant') {
        // Clarifying replies list options as "- Name: chainId"; turn those into
        // one-tap answers.
        const opts = parseChatOptions(text);
        if (opts.length) {
            extras.push(el('div', { class: 'chat-quick' }, opts.map(o =>
                el('button', {
                    class: 'chip', type: 'button', text: o.label,
                    onclick: () => sendAssistantMessage(o.reply)
                }))));
        }
    }
    if (degraded) extras.push(el('span', { class: 'chat-flag', text: 'partial answer' }));
    if (viaFallback) extras.push(el('span', { class: 'chat-flag', text: 'backup model' }));

    // Provenance: the tools that produced this answer, plus links into the
    // dashboard for the chains those calls actually referenced. Chain links come
    // from tool ARGUMENTS, never from parsing numbers out of the prose — a
    // number in text is not evidence the model looked it up.
    if (toolCalls?.length) {
        const names = [...new Set(toolCalls.map(c => c.name))];
        const sources = el('div', { class: 'chat-sources' }, [
            el('div', { class: 'chat-sources-label', text: `Answered using ${names.length} API tool${names.length === 1 ? '' : 's'}` }),
            el('div', { class: 'chat-tool-list' }, names.map(n => el('span', { class: 'chat-tool', text: n })))
        ]);
        const ids = [...new Set(toolCalls
            .map(c => c.args?.chainId)
            .filter(id => id != null && state.byId.has(Number(id)))
            .map(Number))];
        if (ids.length) {
            sources.appendChild(el('div', { class: 'affected-chains' }, ids.slice(0, 6).map(id =>
                el('button', {
                    class: 'chain-chip', type: 'button',
                    text: state.byId.get(id)?.name || `Chain ${id}`,
                    onclick: () => openChainDetail(id)
                }))));
        }
        extras.push(sources);
    }

    const bubble = el('div', { class: `chat-bubble ${role}` }, [body, ...extras]);
    log.appendChild(bubble);
    log.scrollTop = log.scrollHeight;
    return bubble;
}

// The leading bullet is REQUIRED so an ordinary line like "Chain ID: 8453"
// does not sprout a button.
function parseChatOptions(text) {
    const opts = [];
    const seen = new Set();
    for (const line of String(text).split('\n')) {
        const m = line.match(/^\s*[-*]\s+(.{1,48}?):\s*`?(\d{2,10})`?\s*$/);
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
    const log = byId('assistantLog');
    const notice = el('div', { class: 'chat-notice', text });
    log.appendChild(notice);
    log.scrollTop = log.scrollHeight;
    return notice;
}

// Normalize the step trace across server versions.
function assistantStepsFrom(data) {
    if (Array.isArray(data?.steps)) return data.steps.map(s => (typeof s === 'string' ? { label: s } : s));
    if (data?.step) return [{ label: data.step }];
    return null;
}

function appendChatThinking() {
    const log = byId('assistantLog');
    const trace = el('div', { class: 'chat-trace hidden' });
    const elapsed = el('span', { class: 'chat-elapsed' });
    const bubble = el('div', {
        class: 'chat-bubble assistant chat-thinking', 'aria-label': 'Assistant is working'
    }, [
        el('div', { class: 'chat-dots-row' }, [
            el('div', { class: 'chat-dots' }, [el('span'), el('span'), el('span')]),
            elapsed
        ]),
        trace
    ]);
    log.appendChild(bubble);
    log.scrollTop = log.scrollHeight;

    const startedAt = Date.now();
    const timer = setInterval(() => {
        elapsed.textContent = `${Math.round((Date.now() - startedAt) / 1000)}s`;
    }, 1000);
    const baseRemove = bubble.remove.bind(bubble);
    bubble.remove = () => { clearInterval(timer); baseRemove(); };

    let renderedKey = null;
    bubble.setSteps = steps => {
        if (!Array.isArray(steps) || steps.length === 0) return;
        const last = steps[steps.length - 1];
        const key = `${steps.length}|${last.at ?? ''}|${last.label}`;
        if (key === renderedKey) return;
        renderedKey = key;
        // Only auto-scroll when already at the bottom — never yank the reader
        // away from history they scrolled up to read.
        const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
        clear(trace);
        steps.forEach((s, i) => {
            const current = i === steps.length - 1;
            const durMs = !current && s.at != null && steps[i + 1]?.at != null ? steps[i + 1].at - s.at : null;
            const label = current ? `${s.label}…`
                : durMs != null && durMs >= 100 ? `${s.label} (${(durMs / 1000).toFixed(1)}s)`
                    : s.label;
            trace.appendChild(el('div', { class: `chat-trace-step${current ? ' active' : ' done'}` }, [
                el('span', { class: 'chat-trace-mark', text: current ? '›' : '✓' }),
                el('span', { text: label })
            ]));
        });
        trace.classList.remove('hidden');
        if (nearBottom) log.scrollTop = log.scrollHeight;
    };
    return bubble;
}

// Minimal markdown for assistant replies. HTML-escapes FIRST, then layers
// formatting on the escaped text, so model output can never inject markup.
function renderAssistantMarkdown(text) {
    const escaped = String(text)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    return escaped.split(/\n{2,}/).map(block => {
        const lines = block.split('\n');
        const isList = lines.every(l => /^\s*[-*] /.test(l) || l.trim() === '');
        if (isList && lines.some(l => l.trim())) {
            const items = lines.filter(l => l.trim())
                .map(l => `<li>${inlineMd(l.replace(/^\s*[-*] /, ''))}</li>`).join('');
            return `<ul>${items}</ul>`;
        }
        return `<p>${lines.map(inlineMd).join('<br>')}</p>`;
    }).join('');
}
function inlineMd(s) {
    return s
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(https?:\/\/[^\s<)]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

// ═════════════════════════════════════════════════════════════════════════
// Ecosystem news (chains-news)
//
// The third feed, and the one with the loosest link to the registry: it relays
// industry articles, and only a minority mention a chain the registry knows.
// That shapes the whole view — the unit is a STORY, not a chain.
//
// Stories, not articles: `?group=story` folds the same event reported by
// several publishers into one entry with `articleCount` and `sources[]`. Listing
// raw articles would make a widely-covered story look like N separate events.
//
// Enrichment is optional here in a way it is not for the other feeds: the
// service runs as a pure relay unless LLM_ENABLED is set, and its WS `hello`
// frame carries `enrichment: false` to say phase two will never arrive. The
// classification filters stay hidden in that case rather than offering filters
// that can only ever match nothing.
// ═════════════════════════════════════════════════════════════════════════
const news = {
    stories: new Map(),          // storyId → story
    enrichByStory: new Map(),
    sources: new Map(),          // sourceId → {id, name, count}
    loaded: false, loading: false, unreachable: false,
    ws: null, retries: 0, rerenderTimer: null,
    scope: 'all', classFilter: 'all',
    // null = not yet known; false = the relay will never classify.
    enrichmentAvailable: null,
    shown: null
};
const NEWS_PAGE = 25;

// Low-signal classes the feed deliberately tags rather than drops, so the
// consumer decides. Surfacing the choice beats silently hiding rows.
const LOW_SIGNAL_CLASSES = new Set(['market']);

function initNewsControls() {
    document.querySelectorAll('#newsScope .chip').forEach(chip => {
        chip.addEventListener('click', () => {
            news.scope = chip.dataset.scope;
            news.shown = null;
            document.querySelectorAll('#newsScope .chip').forEach(c =>
                c.setAttribute('aria-pressed', String(c === chip)));
            renderNewsList();
        });
    });
}

function ensureNewsView() {
    if (news.loaded) { renderNewsSources(); return; }
    if (news.loading) return;
    news.loading = true;
    setNewsLive(false);
    loadNewsFeed();
}
function setNewsLive(live) { setLiveDot('newsMeta', live); }

async function loadNewsFeed() {
    try {
        // Ask for stories directly; the service does the cross-publisher grouping.
        const res = await fetch(`${NEWS_BASE}/news?limit=200&group=story`, {
            headers: { accept: 'application/json' },
            signal: AbortSignal.timeout(20000)
        });
        if (!res.ok) throw new Error(String(res.status));
        const payload = await res.json();
        for (const story of payload.news || []) upsertStory(story);
        news.loaded = true;
        news.unreachable = false;
    } catch {
        news.unreachable = true;
        renderNewsUnavailable();
        return;
    } finally {
        news.loading = false;
    }
    rebuildNewsSources();
    renderNewsStats();
    renderNewsSources();
    renderNewsClassChips();
    renderNewsList();
    connectNewsFeed();
}

function renderNewsUnavailable() {
    const list = byId('newsList');
    if (list) {
        clear(list);
        list.appendChild(el('div', { class: 'feed-empty' }, [
            el('div', { text: 'Ecosystem news feed unavailable (chains-news).' }),
            el('div', {
                class: 'note', style: 'border:0;margin-top:8px;padding:0',
                text: 'This feed is a separate service. If it has not been deployed and routed yet, this tab stays empty — every other view is unaffected.'
            })
        ]));
    }
    const note = byId('newsNote');
    if (note) note.textContent = '';
    // Don't leave an empty "Classification" filter group (or stale counts)
    // stranded above an unavailable feed.
    byId('newsClassGroup')?.classList.add('hidden');
    for (const id of ['newsChainCount', 'newsMultiCount', 'newsCount']) {
        const n = byId(id);
        if (n) n.textContent = '';
    }
    clear(byId('newsStats'));
    setNewsLive(false);
}

function upsertStory(s) {
    const id = s.storyId || s.id;
    if (!id) return false;
    const whenMs = Date.parse(s.publishedAt || s.updatedAt || '');
    const item = {
        storyId: id,
        title: s.title || '(untitled)',
        url: s.url || null,
        summary: s.summary || '',
        whenMs: Number.isNaN(whenMs) ? null : whenMs,
        articleCount: s.articleCount ?? (Array.isArray(s.articles) ? s.articles.length : 1),
        // A story can be carried by several publishers; keep them all.
        sources: Array.isArray(s.sources) ? s.sources
            : s.source ? [s.source] : [],
        chains: Array.isArray(s.chains) ? s.chains.filter(c => c?.chainId != null) : [],
        tags: Array.isArray(s.tags) ? s.tags : [],
        articles: Array.isArray(s.articles) ? s.articles : []
    };
    const prev = news.stories.get(id);
    if (prev && (prev.whenMs || 0) >= (item.whenMs || 0) && prev.articleCount >= item.articleCount) return false;
    news.stories.set(id, item);
    if (s.enrichment) news.enrichByStory.set(id, s.enrichment);
    return true;
}

// A raw `news.item` frame is an ARTICLE. Fold it into its story so the live
// stream and the grouped backfill stay in the same unit.
function upsertArticle(a) {
    const sid = a.storyId || a.id;
    if (!sid) return false;
    const existing = news.stories.get(sid);
    const whenMs = Date.parse(a.publishedAt || a.updatedAt || '');
    if (!existing) {
        return upsertStory({
            storyId: sid, title: a.title, url: a.url, summary: a.summary,
            publishedAt: a.publishedAt, articleCount: 1,
            sources: a.source ? [a.source] : [], chains: a.chains, tags: a.tags,
            articles: [a], enrichment: a.enrichment
        });
    }
    // Already known: merge the publisher and refresh recency.
    let changed = false;
    if (a.source?.id && !existing.sources.some(x => x.id === a.source.id)) {
        existing.sources.push(a.source);
        existing.articleCount += 1;
        changed = true;
    }
    if (!Number.isNaN(whenMs) && (existing.whenMs == null || whenMs > existing.whenMs)) {
        existing.whenMs = whenMs;
        changed = true;
    }
    if (a.enrichment) { news.enrichByStory.set(sid, a.enrichment); changed = true; }
    return changed;
}

function connectNewsFeed() {
    setNewsLive(false);
    const wsUrl = `${NEWS_BASE.replace(/^http/, 'ws')}/ws?replay=1`;
    let ws;
    try { ws = new WebSocket(wsUrl); } catch { return; }
    news.ws = ws;
    ws.onopen = () => { news.retries = 0; setNewsLive(true); };
    ws.onmessage = ev => {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'hello') {
            // Authoritative answer to "will classifications ever arrive?".
            news.enrichmentAvailable = Boolean(m.enrichment);
            renderNewsClassChips();
            renderNewsStats();
            return;
        }
        if (m.type === 'news.item' && m.item) {
            if (upsertArticle(m.item)) scheduleNewsRerender();
        } else if (m.type === 'news.enrichment' && (m.storyId || m.eventId || m.id)) {
            const key = m.storyId || m.eventId || m.id;
            // Enrichments are story-keyed; an article id resolves via its story.
            const target = news.stories.has(key)
                ? key
                : [...news.stories.values()].find(s => s.articles.some(a => a.id === key))?.storyId;
            if (target) {
                news.enrichByStory.set(target, m);
                news.enrichmentAvailable = true;
                scheduleNewsRerender();
            }
        }
    };
    ws.onerror = () => { try { ws.close(); } catch { /* noop */ } };
    ws.onclose = () => {
        news.ws = null;
        setNewsLive(false);
        if (news.retries < 6) {
            const delay = Math.min(1000 * 2 ** news.retries, 20000);
            news.retries++;
            setTimeout(connectNewsFeed, delay);
        }
    };
}

function scheduleNewsRerender() {
    if (news.rerenderTimer) return;
    news.rerenderTimer = setTimeout(() => {
        news.rerenderTimer = null;
        rebuildNewsSources();
        if (activeView === 'news') {
            renderNewsStats();
            renderNewsSources();
            renderNewsClassChips();
            renderNewsList();
        }
    }, 400);
}

function rebuildNewsSources() {
    const map = new Map();
    for (const s of news.stories.values()) {
        for (const src of s.sources) {
            if (!src?.id) continue;
            const cur = map.get(src.id) || { id: src.id, name: src.name || src.id, count: 0, weight: src.weight || null };
            cur.count += 1;
            map.set(src.id, cur);
        }
    }
    news.sources = map;
}

function newsList() { return [...news.stories.values()].sort((a, b) => (b.whenMs || 0) - (a.whenMs || 0)); }
function enrichmentOfStory(s) { return news.enrichByStory.get(s.storyId) || null; }
function storyClass(s) {
    const e = enrichmentOfStory(s);
    return e?.class ? String(e.class) : null;
}

function newsMatchesSearch(s, q) {
    if (s.title.toLowerCase().includes(q)) return true;
    if (s.sources.some(x => (x.name || '').toLowerCase().includes(q))) return true;
    if ((s.tags || []).some(t => String(t).toLowerCase().includes(q))) return true;
    return s.chains.some(c => String(c.chainId).includes(q) || (c.name || '').toLowerCase().includes(q));
}

function visibleNews() {
    let items = newsList();
    if (news.scope === 'chain') items = items.filter(s => s.chains.length);
    else if (news.scope === 'multi') items = items.filter(s => s.articleCount > 1);
    if (news.classFilter !== 'all') items = items.filter(s => storyClass(s) === news.classFilter);
    if (searchQuery) items = items.filter(s => newsMatchesSearch(s, searchQuery));
    return items;
}

function renderNewsStats() {
    const wrap = byId('newsStats');
    if (!wrap) return;
    const all = newsList();
    const articles = all.reduce((n, s) => n + s.articleCount, 0);
    const withChain = all.filter(s => s.chains.length);
    const multi = all.filter(s => s.articleCount > 1);
    const enriched = all.filter(s => enrichmentOfStory(s)).length;
    clear(wrap);
    wrap.appendChild(statTile({
        label: 'Stories', value: fmtNum(all.length), hero: true,
        sub: `from ${fmtNum(articles)} article${articles === 1 ? '' : 's'}`,
        hint: 'One story groups the same event as reported by several publishers, so widely-covered news is not double counted.'
    }));
    wrap.appendChild(statTile({
        label: 'Publishers', value: fmtNum(news.sources.size),
        sub: 'currently in the retained window'
    }));
    wrap.appendChild(statTile({
        label: 'Mentions a known chain', value: all.length ? Viz.fmtPct((withChain.length / all.length) * 100, 0) : '—',
        sub: `${fmtNum(withChain.length)} of ${fmtNum(all.length)} stories`,
        hint: 'Share of stories naming a chain the registry recognises. Most ecosystem news is not chain-specific, so a low figure is expected.'
    }));
    wrap.appendChild(statTile({
        label: 'Covered by several outlets', value: fmtNum(multi.length),
        sub: multi.length ? 'more than one publisher' : 'no overlapping coverage yet',
        hint: 'Stories carried by more than one source. Corroboration across publishers, not an importance score.'
    }));
    // Only claim a classification rate when classification is actually running.
    if (news.enrichmentAvailable !== false && enriched > 0) {
        wrap.appendChild(statTile({
            label: 'AI classified', value: all.length ? Viz.fmtPct((enriched / all.length) * 100, 0) : '—',
            sub: `${fmtNum(enriched)} of ${fmtNum(all.length)} stories`,
            hint: 'Share of stories with an LLM classification from the feed. Unclassified stories are never given a guessed class.'
        }));
    }
}

function renderNewsSources() {
    const host = byId('chartNewsSources');
    if (!host || !news.loaded) return;
    const data = [...news.sources.values()]
        .sort((a, b) => b.count - a.count)
        .map(s => ({ label: s.name, value: s.count }));
    const res = Viz.barChart(host, {
        data, valueFmt: Viz.fmtNum, axisFmt: Viz.fmtAxisNum,
        unit: 'Articles retained', tableCaption: 'Articles retained per publisher'
    });
    const actions = byId('newsSourceActions');
    if (actions && res?.table) {
        clear(actions);
        host.appendChild(res.table);
        Viz.attachTableToggle(host, res.table, actions);
    }
}

// Classification chips are built from what the feed actually returned. When the
// relay runs unclassified they are hidden entirely — an empty filter row that
// can never match is worse than no filter row.
function renderNewsClassChips() {
    const group = byId('newsClassGroup');
    const wrap = byId('newsClassChips');
    if (!group || !wrap) return;
    const counts = new Map();
    for (const s of newsList()) {
        const c = storyClass(s);
        if (c) counts.set(c, (counts.get(c) || 0) + 1);
    }
    if (!counts.size) {
        group.classList.add('hidden');
        news.classFilter = 'all';
        return;
    }
    group.classList.remove('hidden');
    clear(wrap);
    const mk = (key, label, count) => wrap.appendChild(el('button', {
        class: 'chip', type: 'button',
        'aria-pressed': String(news.classFilter === key),
        onclick: () => { news.classFilter = key; news.shown = null; renderNewsClassChips(); renderNewsList(); }
    }, [label, count != null ? el('span', { class: 'chip-count', text: fmtNum(count) }) : null]));
    mk('all', 'Any', newsList().length);
    for (const [c, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
        const label = c.replace(/_/g, ' ') + (LOW_SIGNAL_CLASSES.has(c) ? ' (low signal)' : '');
        mk(c, label, n);
    }
}

function newsCard(s) {
    const enr = enrichmentOfStory(s);
    const when = s.whenMs ? relTime(new Date(s.whenMs).toISOString()) : null;
    const publishers = s.sources.map(x => x.name || x.id).filter(Boolean);

    const main = el('div', { class: 'incident-main' }, [
        el('div', { class: 'incident-title' }, [
            s.articleCount > 1
                ? el('span', { class: 'kind-tag', title: `Reported by ${s.articleCount} sources`, text: `${s.articleCount}×` })
                : null,
            el('span', { class: 'incident-title-text' }, [
                s.url
                    ? el('a', { href: s.url, target: '_blank', rel: 'noopener', text: s.title })
                    : el('span', { text: s.title })
            ])
        ]),
        el('div', {
            class: 'incident-meta',
            // Name every publisher: which outlets carried a story is the
            // corroboration signal, and it is cheap to show.
            text: [publishers.slice(0, 3).join(', ') + (publishers.length > 3 ? ` +${publishers.length - 3}` : ''), when]
                .filter(Boolean).join(' · ')
        })
    ]);

    if (s.summary) {
        main.appendChild(el('div', { class: 'ai-summary', style: 'margin-top:6px', text: Viz.truncate(s.summary, 260) }));
    }

    // AI classification, attributed exactly like the incident cards.
    if (enr?.class || enr?.summary) {
        const conf = Number.isFinite(enr.confidence) ? enr.confidence : null;
        const head = el('div', { class: 'ai-head' }, [
            el('span', { class: 'ai-tag', text: 'AI' }),
            enr.class ? el('span', { class: 'ai-class', text: String(enr.class).replace(/_/g, ' ') }) : null,
            enr.severity ? el('span', { text: `· ${enr.severity}` }) : null
        ]);
        if (conf != null) {
            const bar = el('span', { class: 'ai-conf-bar' }, [el('span', { class: 'ai-conf-fill' })]);
            bar.firstChild.style.width = `${Math.round(conf * 100)}%`;
            head.appendChild(el('span', { class: 'ai-conf', title: 'Model-reported confidence in this classification' }, [
                'confidence ', bar, `${Math.round(conf * 100)}%`
            ]));
        }
        if (enr.model) head.appendChild(el('span', { text: `· ${enr.model}` }));
        const block = el('div', { class: 'ai-block' }, [head]);
        if (enr.summary && enr.summary !== s.summary) {
            block.appendChild(el('div', { class: 'ai-summary', text: enr.summary }));
        }
        main.appendChild(block);
    }

    if (s.chains.length) {
        const chips = el('div', { class: 'affected-chains' });
        for (const c of s.chains.slice(0, 10)) {
            chips.appendChild(el('button', {
                class: 'chain-chip', type: 'button',
                text: c.name || `Chain ${c.chainId}`,
                onclick: () => openChainDetail(c.chainId)
            }));
        }
        main.appendChild(chips);
    }

    const side = el('div', { class: 'incident-side' }, [
        enr?.severity
            ? el('span', { class: `sev sev-${String(enr.severity).toLowerCase().replace(/[^a-z]/g, '') || 'none'}` }, [
                el('span', { class: 'sev-mark' }), String(enr.severity)
            ])
            : null,
        s.chains.length
            ? el('span', { class: 'pill', text: `${s.chains.length} chain${s.chains.length === 1 ? '' : 's'}` })
            : null
    ]);

    return el('div', { class: 'incident-card' }, [main, side]);
}

function renderNewsList() {
    const list = byId('newsList');
    if (!list) return;
    if (news.unreachable) { renderNewsUnavailable(); return; }
    if (!news.loaded) return;

    const items = visibleNews();
    const countEl = byId('newsCount');
    if (countEl) {
        const bits = [`${fmtNum(items.length)} stor${items.length === 1 ? 'y' : 'ies'}`];
        if (news.scope === 'chain') bits.push('mentioning a chain');
        if (news.scope === 'multi') bits.push('with multiple sources');
        if (news.classFilter !== 'all') bits.push(news.classFilter.replace(/_/g, ' '));
        if (searchQuery) bits.push(`matching “${searchQuery}”`);
        countEl.textContent = bits.join(' · ');
    }
    const all = newsList();
    const cc = byId('newsChainCount');
    if (cc) cc.textContent = fmtNum(all.filter(s => s.chains.length).length);
    const mc = byId('newsMultiCount');
    if (mc) mc.textContent = fmtNum(all.filter(s => s.articleCount > 1).length);

    clear(list);
    if (!items.length) {
        list.appendChild(el('div', { class: 'feed-empty', text: 'No stories match these filters.' }));
        return;
    }
    const limit = news.shown ?? (isNarrow() ? 10 : NEWS_PAGE);
    for (const s of items.slice(0, limit)) list.appendChild(newsCard(s));
    if (items.length > limit) {
        list.appendChild(el('div', { class: 'table-foot' }, [
            el('button', {
                class: 'btn', type: 'button',
                text: `Show more — ${fmtNum(items.length - limit)} remaining`,
                onclick: () => { news.shown = limit + (isNarrow() ? 10 : NEWS_PAGE) * 2; renderNewsList(); }
            })
        ]));
    }

    const note = byId('newsNote');
    if (note) {
        const parts = [
            `${fmtNum(all.length)} stories from ${fmtNum(all.reduce((n, s) => n + s.articleCount, 0))} retained articles across ${fmtNum(news.sources.size)} publishers.`
        ];
        if (news.enrichmentAvailable === false) {
            parts.push('This feed is running as a pure relay right now, so no AI classification is available and none is implied.');
        }
        parts.push('Chain links appear only where an article named a chain the registry recognises; the feed tags market commentary rather than dropping it, so low-signal stories are filterable but never hidden from you silently.');
        note.textContent = parts.join(' ');
    }
}
