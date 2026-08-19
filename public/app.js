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
    location.port === '3000' || location.hostname === 'chains-api.johnaverse.cc'
    // The API serves this dashboard itself at /ui/ (any port) — those calls must stay
    // same-origin, or a local or staging server's own UI silently shows production data
    // while looking like it shows that deployment's.
    || location.pathname.startsWith('/ui');
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
// Both spellings are accepted — an object ({ width: '40%' }) and a declaration string
// ('width: 40%') — because the two halves of this file were written to different
// conventions and a mismatch here fails silently rather than loudly. Everything routes
// through setProperty, which also means custom properties (--x: y) work.
function applyStyle(node, v) {
    const decls = typeof v === 'string'
        ? v.split(';').map(d => d.split(':')).filter(p => p.length >= 2)
            .map(([prop, ...rest]) => [prop.trim(), rest.join(':').trim()])
        : Object.entries(v).map(([prop, val]) => [prop.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`), String(val)]);
    for (const [prop, val] of decls) node.style.setProperty(prop, val);
}
function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (v === null || v === undefined) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        // Styles go through the CSSOM, never through a style ATTRIBUTE. The API serves this
        // dashboard at /ui under `style-src 'self'` with no 'unsafe-inline', so a style
        // attribute is dropped there by the browser with NO console error — while the same
        // page on GitHub Pages (which sends no CSP) looks fine. Anything positioned or
        // coloured from JS therefore has to be assigned, or it silently collapses on /ui only.
        else if (k === 'style') applyStyle(node, v);
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v);
    }
    for (const c of [].concat(children)) {
        if (c == null) continue;
        // A string child is ALWAYS text, never markup — createTextNode cannot execute anything.
        if (typeof c === 'string') { node.appendChild(document.createTextNode(c)); continue; }
        // Anything else must be a real Node. An explicit contract rather than a cast: it makes the
        // helper fail safe on a stray value (a number, an object) instead of throwing deep in
        // appendChild, and it states outright that no string can reach this line.
        if (c instanceof Node) node.appendChild(c);
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
    // Seconds below a minute. Rounding everything to minutes rendered a 35-second outage as
    // "1m" and a 3-second step gap as "0m", and uptime-monitor incidents are routinely tens
    // of seconds long. The previous fallback here read "under a minute", which is honest
    // about the magnitude but composes into "+under a minute" in a lifecycle gap and
    // "seen over under a minute" in a duration pill, and cannot tell 3s from 55s.
    if (ms < 60000) return `${Math.max(1, Math.round(ms / 1000))}s`;
    const m = Math.round(ms / 60000);
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
// Only an http(s) URL may become an href. Feed and registry data is third-party, so a
// `javascript:` URL here would be a clickable XSS — CodeQL flagged exactly this class. Returns
// null on anything else, and el() drops a null attribute, so the title still renders as text
// while ceasing to be a link. safeHost() below already applied this rule to the display label;
// this applies it to the destination.
function safeUrl(url) {
    try {
        const u = new URL(url);
        return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
    } catch { return null; }
}

function safeHost(url) {
    try {
        const u = new URL(url);
        return (u.protocol === 'http:' || u.protocol === 'https:') ? u.host : null;
    } catch { return null; }
}

// Provider status pages emit HTML bodies, and when the LLM enrichment falls back to the raw
// body the summary rendered the markup as literal text — "<p><strong>THIS IS A SCHEDULED
// EVENT Aug <var data-var='date'>5</var>…". Tags out, entities decoded, whitespace collapsed.
//
// Deliberately NOT DOMParser: an inert parsed document read via textContent is safe, but
// handing untrusted markup to a parser at all is the wrong shape and CodeQL is right to flag
// it. Plain string work raises no such question, and the only entities these feeds emit are
// the handful mapped below. Every caller assigns the result with textContent.
const NAMED_ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ',
    mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”'
};

function plainText(s) {
    if (typeof s !== 'string') return '';
    if (!/[<&]/.test(s)) return s;
    // Block-ish tags become a space so words either side don't run together.
    let out = s.replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6])\s*\/?>/gi, ' ');
    // Repeat until stable: one pass over `<[^>]*>` reassembles nested tags.
    let previous;
    do {
        previous = out;
        out = out.replace(/<[^>]*>/g, '');
    } while (out !== previous);
    return out.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);/g, (match, ref) => decodeEntity(ref) ?? match)
        .replace(/\s+/g, ' ')
        .trim();
}

function decodeEntity(ref) {
    if (ref[0] !== '#') return NAMED_ENTITIES[ref.toLowerCase()] ?? null;
    const code = /^#[xX]/.test(ref) ? parseInt(ref.slice(2), 16) : Number(ref.slice(1));
    if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return null;
    // Surrogate halves are not standalone code points.
    if (code >= 0xd800 && code <= 0xdfff) return null;
    return String.fromCodePoint(code);
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
    // One snapshot, fetched at boot rather than on first visit to the tab: it is a single
    // small request, and having it already resolved means switching to Providers paints the
    // board immediately instead of after a round-trip.
    loadProviderStats();
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
const VIEWS = ['overview', 'networks', 'graph', 'incidents', 'providers', 'timeline', 'news', 'forum'];
// The five feed views share one top-level "Activity" tab; the strip built by
// initSubTabs() inside each of their sections picks between them. URLs are
// untouched — ?view=news still deep-links, it just lights up Activity + News.
const FEED_VIEWS = ['incidents', 'providers', 'timeline', 'news', 'forum'];
const FEED_LABELS = { incidents: 'Incidents', providers: 'Providers', timeline: 'Timeline', news: 'News', forum: 'Forum' };
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
        // The Activity button's dataset.view tracks the active feed (see
        // switchView), so this lookup also matches while a feed is open.
        const i = tabs.findIndex(t => t.dataset.view === activeView);
        const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
        next.focus();
        switchView(next.dataset.view);
    });
    initSubTabs();
}

// ONE feed-switcher strip, reparented into the active feed section by
// switchView(). A single node means a single badge and a single aria pass —
// the five-copies version this replaces needed a document-wide fan-out to
// keep 25 buttons and 5 badges in sync, and still printed five nav strips.
//
// Deliberately plain navigation, NOT a tablist: the five feed sections are
// tabpanels of the TOP tablist, so a nested tablist inside a panel whose
// selected tab points at its own ancestor reads as circular to AT. Buttons
// mark the current feed with aria-current instead, and stay ordinary
// sequential tab stops.
let subTabStrip = null;
let subTabBadge = null;
function initSubTabs() {
    subTabStrip = el('nav', { class: 'subtabs', 'aria-label': 'Activity feeds' });
    for (const v of FEED_VIEWS) {
        const btn = el('button', {
            class: 'subtab', type: 'button', 'data-view': v,
            onclick: () => switchView(v)
        }, [FEED_LABELS[v]]);
        if (v === 'incidents') {
            subTabBadge = el('span', { class: 'tab-badge hidden' });
            btn.appendChild(subTabBadge);
        }
        subTabStrip.appendChild(btn);
    }
}

function switchView(view, opts = {}) {
    if (!VIEWS.includes(view)) view = DEFAULT_VIEW;
    activeView = view;
    // The Activity tab remembers the feed the reader was on: its dataset.view
    // is updated to the current feed, which also makes the generic
    // aria-selected loop below light it up for any of the five.
    if (FEED_VIEWS.includes(view)) {
        const act = byId('tab-activity');
        if (act) { act.dataset.view = view; act.setAttribute('aria-controls', `view-${view}`); }
    }
    document.querySelectorAll('#tabs .tab').forEach(b =>
        b.setAttribute('aria-selected', String(b.dataset.view === view)));
    if (subTabStrip) {
        for (const b of subTabStrip.children) {
            if (b.dataset.view === view) b.setAttribute('aria-current', 'true');
            else b.removeAttribute('aria-current');
        }
    }
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    byId(`view-${view}`)?.classList.add('active');
    // Move the shared feed strip into the section being shown — AFTER the
    // section is active: a node move drops focus to <body>, and re-focusing
    // an element inside a display:none ancestor is a silent no-op.
    if (FEED_VIEWS.includes(view) && subTabStrip) {
        const inner = document.querySelector(`#view-${view} .view-inner`);
        if (inner && subTabStrip.parentElement !== inner) {
            const hadFocus = subTabStrip.contains(document.activeElement);
            inner.prepend(subTabStrip);
            if (hadFocus) subTabStrip.querySelector(`[data-view="${view}"]`)?.focus();
        }
    }
    document.body.classList.toggle('graph-active', view === 'graph');

    if (view === 'networks' && chainsTableStale) { chainsTableStale = false; renderChainsTable(); }
    if (view === 'graph') ensureGraphView();
    else pauseGraph();   // stop the WebGL loop the moment the graph is hidden
    if (view === 'forum') ensureForumView();
    if (view === 'news') ensureNewsView();
    if (view === 'overview') renderOverview();
    if (view === 'incidents') renderIncidents();
    if (view === 'providers') renderProviders();
    // The else is load-bearing: the timeline arms a 60s countdown ticker, and its own guard
    // silently returns when another view is active — so a leaked interval has no symptom at
    // all beyond a full re-render firing behind whatever tab the reader is on.
    if (view === 'timeline') ensureTimelineView();
    else stopTimelineTicker();

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
                    : activeView === 'timeline' ? 'Filter timeline — network, software or title…'
                    : activeView === 'news' ? 'Filter news — title, source or network…'
                : activeView === 'forum' ? 'Filter posts — network, forum or title…'
                        : 'Search networks — id or name…';
}

function applySearch() {
    if (activeView === 'networks') { chainShown = null; renderChainsTable(); }
    else if (activeView === 'incidents') renderIncidentList();
    else if (activeView === 'providers') renderProviderList();
    else if (activeView === 'timeline') renderTimeline();
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

// The CSS token for a status label ('In progress' → 'inprogress'). One list maps a
// status to a colour (see `.st-*` in style.css) and everything that needs one reads it
// from there — the lifecycle dots originally shipped a second copy of the palette keyed
// on the feed's RAW enum ('major_outage') while the labels are display strings ('Major
// outage'), so every maintenance step rendered grey.
function statusToken(status) {
    return status ? String(status).toLowerCase().replace(/\s+/g, '') : null;
}

// Cap the per-incident transition list. An Atlassian incident can carry dozens of
// updates; the card shows a lifecycle, not a changelog.
const MAX_TRANSITIONS = 24;

// Merge one event into an incident's ordered transition list, newest last and deduped so
// a re-broadcast cannot double the strip. Both the REST backfill and the WS replay call
// this, so the same event genuinely arrives twice; an event with no id falls back to its
// timestamp+title rather than skipping dedup entirely.
//
// Mutates the list in place AND returns it — incidentModel uses the return value while
// addIncidents relies on the mutation, so it must keep doing both.
function addTransition(list, ev, ms) {
    if (ms == null) return list;
    const id = ev.id ?? `${ms}|${ev.title || ''}`;
    if (list.some(t => t.id === id)) return list;
    // Status comes from the feed's normalized enum only. Older cached events that predate
    // the field get a null status, which paints an uncoloured dot — the honest rendering
    // of "the feed did not classify this state". Nothing is inferred from the wording.
    list.push({ id, ms, title: ev.title || '', status: STATUS_LABEL[ev.status] || null });
    list.sort((a, b) => a.ms - b.ms);
    if (list.length > MAX_TRANSITIONS) list.splice(0, list.length - MAX_TRANSITIONS);
    return list;
}
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
    none: { key: 'none', label: 'Not classified', cssVar: '--cat-0' },
    // A severity the feed sent that this scale does not know. Contract §8 records that the
    // two feeds do not share a vocabulary and expects drift, so folding an unknown level into
    // "Not classified" would deflate the classified count with nothing anywhere to say why.
    unknown: { key: 'unknown', label: 'Unrecognized severity', cssVar: '--cat-1' }
};

const incidents = {
    items: [], byKey: new Map(), ws: null, retries: 0,
    groupBy: 'flat', dayFilter: null, category: 'all', severity: 'all', shown: null,
    backfilled: false, backfillInFlight: false,
    // Two-phase enrichment: most events carry `enrichment` inline on the REST
    // backfill, but live WS `status.enrichment` frames arrive separately and
    // are keyed by raw eventId. eventToKey resolves an eventId to its incident;
    // enrichPending stashes frames that beat their item.
    eventToKey: new Map(), enrichByKey: new Map(), enrichPending: new Map(), enrichTimer: null,
    // Whether phase two can EVER arrive, per the feed's own `hello` frame (contract §7).
    // null until the socket says. Without it "0% classified" and "classifier switched off
    // upstream" are the same picture, and the second one is not this dashboard's fault.
    enrichmentAvailable: null
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

// The feed publishes a stable per-INCIDENT id alongside the per-event one; use it. The
// fallback below keys on source+title, which merges every incident a provider ever gave
// the same name: on 500 live events that collapsed 274 real incidents into 172 cards, 80
// of which fused more than one distinct incident. The lifecycle strip is what exposed it —
// four "Resolved" steps three days apart are not one incident's history. Kept only for
// older cached events that predate the field.
function incidentKey(ev) {
    if (ev.incidentId) return ev.incidentId;
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
        // What happened, in order — one entry per state the feed published. This is what
        // turns "went down" + "recovered" from two unrelated cards into one readable
        // lifecycle.
        transitions: addTransition([], ev, whenMs),
        // The title of the OPENING event, kept separately: the newest event wins for
        // current state, but a card headlined "Portal recovered" describes the end of the
        // story rather than the incident. Atlassian incidents keep one title throughout,
        // so this is a no-op for them.
        openedTitle: ev.title || '(untitled)',
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
            if (early) { incidents.enrichPending.delete(ev.id); applyEnrichment(m.key, early, m.whenMs); }
        }
        // The REST backfill ships enrichment INLINE on most events. The old
        // dashboard only read WS enrichment frames, so several hundred existing
        // AI classifications were discarded on every page load.
        //
        // Several events of one incident each carry their own classification, so the event's
        // own time is what orders them — see enrichmentStamp.
        if (ev.enrichment) applyEnrichment(m.key, ev.enrichment, m.whenMs);

        const existing = incidents.byKey.get(m.key);
        if (!existing) { incidents.byKey.set(m.key, m); changed = true; continue; }

        if (m.whenMs != null) {
            const opening = existing.firstSeen == null || m.whenMs < existing.firstSeen;
            existing.firstSeen = Math.min(existing.firstSeen ?? m.whenMs, m.whenMs);
            existing.lastSeen = Math.max(existing.lastSeen ?? m.whenMs, m.whenMs);
            addTransition(existing.transitions ??= [], ev, m.whenMs);
            // An earlier event can arrive after a later one — the recovery is often parsed
            // first, and a restart replays history out of order — so the headline follows
            // the earliest event, not arrival order.
            if (opening) existing.openedTitle = m.openedTitle;
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
    // A live frame with no timestamp of its own is, by definition, the newest thing we know.
    if (applyEnrichment(key, enr, Date.now())) scheduleEnrichmentRerender();
}

// When a classification was made, resolved against fields that actually exist on the wire.
// `createdAt` was the sole ordering key here and appears NOWHERE else in this repo — not in
// the service contract, not in the server-side reader, not in a fixture. When it is absent
// Date.parse yields NaN, both sides of the comparison collapse to 0, and "newest wins"
// quietly becomes "whichever was processed last". That is invisible live (a re-classification
// does arrive last) and wrong after a reload, where the REST backfill replays every event of
// an incident and the winner is decided by array order.
//
// So: the feed's own classification time if it sends one, then the frame's emittedAt
// (contract §7 puts it on every frame), then the time of the event being classified.
function enrichmentStamp(enr, fallbackMs) {
    for (const raw of [enr?.createdAt, enr?.emittedAt]) {
        if (raw == null) continue;
        // Contract §9 says ISO-8601, but this whole finding was about trusting a field shape
        // nobody had verified — so an epoch number is read as one rather than handed to
        // Date.parse, which would read 1770000000000 as a year and answer with a real-looking
        // timestamp in the far future that then wins every comparison forever.
        if (typeof raw === 'number') {
            if (Number.isFinite(raw)) return raw;
            continue;
        }
        const t = Date.parse(raw);
        if (!Number.isNaN(t)) return t;
    }
    return fallbackMs ?? 0;
}

// Newest enrichment wins per incident (a later update can re-classify it). An older frame
// loses; equal timestamps let the later arrival win so a re-classification is never dropped.
// Stores the resolved stamp beside the payload — recomputing it from the stored object would
// reintroduce the same problem for whichever field was missing.
function applyEnrichment(key, enr, atMs) {
    // Never store a classification-free payload. The feed can send `enrichment: {}`, or an
    // object carrying only fields this dashboard does not read, and storing it made
    // enrichmentOf() truthy for an event with nothing classified about it — which is how the
    // stat and the card came to disagree in the first place. Enforcing it here means "we have
    // an enrichment" and "there is a classification" cannot drift apart again.
    if (!hasClassification(enr)) return false;
    // Seeing a classification at all is proof phase two is running, whatever `hello` said
    // (or if the socket never sent one because the data came over REST).
    incidents.enrichmentAvailable = true;
    const at = enrichmentStamp(enr, atMs);
    const prev = incidents.enrichByKey.get(key);
    if (prev && prev.at > at) return false;
    incidents.enrichByKey.set(key, { data: enr, at });
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

// The ONE door from a feed-supplied severity to anything rendered. Every label and
// every `sev-*` class comes out of SEVERITY_META, so an unexpected value degrades to
// "Not classified" instead of printing itself — and no feed string ever reaches the DOM
// or a class attribute. Both call paths (incident cards, news cards) go through here.
function severityMeta(raw) {
    if (raw == null || raw === '') return SEVERITY_META.none;
    // Nothing sent vs. something sent that we cannot place are different states: the first is
    // an unclassified event, the second is a taxonomy drift someone needs to fix.
    return SEVERITY_META[String(raw).toLowerCase()] || SEVERITY_META.unknown;
}
function severityOf(it) {
    return severityMeta(enrichmentOf(it)?.severity);
}
function enrichmentOf(it) { return incidents.enrichByKey.get(it.key)?.data || null; }

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
    // Two badges, two scopes. The Activity tab fronts all five feeds, so its
    // count is EVERY open incident — provider-only trouble must not leave it
    // looking quiet. The Incidents sub-tab keeps the chain-only count its
    // feed actually shows.
    const open = incidents.items.filter(isOpen);
    const setBadge = (badge, n, what) => {
        if (!badge) return;
        badge.textContent = n ? String(n) : '';
        badge.classList.toggle('hidden', !n);
        badge.title = n ? `${n} open ${what}${n === 1 ? '' : 's'}` : '';
    };
    setBadge(byId('tabBadgeIncidents'), open.length, 'incident');
    setBadge(subTabBadge, open.filter(it => !it.isProvider).length, 'chain incident');
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
        // The feed's own answer to "can a classification ever arrive?" (contract §7). The
        // news socket has always honoured this; this one ignored it, so a feed running as a
        // pure relay showed "AI classified 0%" and a severity filter that could never match
        // — a switched-off classifier upstream rendered as a broken panel here.
        if (m.type === 'hello') {
            incidents.enrichmentAvailable = Boolean(m.enrichment);
            scheduleIncidentRepaint();
            return;
        }
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
// Overview — the cross-cutting view. Everything on THIS page is a current reading and nothing
// here implies a trend. That is a choice about the page, not a fact about the API: provider
// availability comes in 24h/7d/30d windows with a per-day series, and upgrade windows are
// dated. Those belong to the Providers and Timeline views; mixing a trend in here would make
// the rest of the tiles read as trends too.
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
    // The definition rides on the label itself (cursor:help via [title]), not
    // on an ⓘ dot — six of them in one strip was circled punctuation, and the
    // strip is the most-looked-at row on the page. But title on a plain div
    // is hover-only, so the same sentence also goes into the tile as sr-only
    // text: screen readers get it in flow, without a dot to hunt for.
    const lab = el('div', hint ? { class: 'stat-label', title: hint } : { class: 'stat-label' }, [label]);
    if (hint) lab.appendChild(el('span', { class: 'sr-only', text: `. ${hint}` }));
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

    // Geometry rule: the reserved height holds until the feed has SETTLED
    // (backfill landed), and collapses only on a confirmed zero. Collapsing
    // during the waiting state looked nicer but meant every load with an
    // open incident shifted the page ~400px downward when the feed arrived —
    // the exact CLS the fixed height was added to prevent. Under this rule a
    // load with incidents never shifts, and a zero-incident load shifts once,
    // upward, into a state that then stays stable.
    const settled = incidents.backfilled;
    host.classList.toggle('is-collapsed', !rows.length && settled);
    if (!rows.length) {
        host.appendChild(el('div', {
            class: 'feed-empty',
            text: !settled
                ? 'Waiting for the live status feed…'
                : (incidents.items.some(isOpen)
                    ? 'Nothing open in this scope.'
                    : `No open incidents — ${state.chains.length ? fmtNum(state.chains.length) + ' networks clear' : 'all clear'}.`)
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
                        href: safeUrl(it.url), target: '_blank', rel: 'noopener',
                        text: it.openedTitle || it.title, title: it.openedTitle || it.title,
                        // The row opens the chain drawer; the link opens the
                        // upstream report. Don't fire both.
                        onclick: e => e.stopPropagation()
                    })
                    : el('span', { text: it.openedTitle || it.title, title: it.openedTitle || it.title }),
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

    // Three named segments plus a neutral remainder: three is the validated all-pairs colour cap,
    // so a fourth named segment would have to reuse a hue already on screen.
    const TOP_N = 3;
    const parts = sorted.slice(0, TOP_N).map(p => ({ label: p.displayName || p.slug, value: p.tvs }));
    const restVal = sorted.slice(TOP_N).reduce((sum, p) => sum + p.tvs, 0);
    if (restVal > 0) parts.push({ label: `Other (${sorted.length - TOP_N})`, value: restVal });

    renderWhenVisible(host, () => paintConcentration(host, sorted, parts));
}

function paintConcentration(host, sorted, parts) {
    const res = Viz.compositionBar(host, {
        parts, valueFmt: fmtUsd, maxSlots: 3,
        tableCaption: 'Share of total value secured'
    });
    const actions = byId('concentrationActions');
    if (actions && res?.table) {
        clear(actions);
        host.appendChild(res.table);
        Viz.attachTableToggle(host, res.table, actions);
    }
    const total = totalTvs();
    const topN = 3;
    const topShare = sorted.slice(0, topN).reduce((sum, p) => sum + p.tvs, 0);
    host.appendChild(el('p', {
        class: 'note',
        text: `The ${topN} largest projects hold ${Viz.fmtPct((topShare / total) * 100)} of ${fmtUsd(total)} total value secured across ${fmtNum(sorted.length)} projects reporting a non-zero figure.`
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
// Once the Incident column has appeared it stays for the session: its
// visibility rides on live WebSocket state, and letting the last upstream
// resolution yank the column (and the reader's sort) out from under a
// scrolled table was worse than one now-empty column.
let incidentColLatched = false;

// aria-sort has exactly one writer. Both the header click handler and the
// hidden-column sort fallback in renderChainsTable() route through here, so
// the caret can never disagree with chainSort.
function syncChainSortHeaders() {
    document.querySelectorAll('#chainsTable thead th[data-sort]').forEach(th =>
        th.setAttribute('aria-sort', th.dataset.sort !== chainSort.key ? 'none'
            : chainSort.dir === 1 ? 'ascending' : 'descending'));
}
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
            syncChainSortHeaders();
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

    // Columns that are absence on ~95% of rows stay hidden until the reader
    // signals intent toward them — a grid of em-dashes reads as broken data
    // even when it is correct. Intent for the L2BEAT pair is any of: the
    // L2BEAT filter, the L2/rollup type filter (every visible row has the
    // data then), or a sort on one of the two columns. Deliberately NOT
    // data-driven from the row set: search results changing per keystroke
    // must not make columns pop in and out.
    const showL2b = chainTvsOnly || chainTypeFilter === 'l2'
        || chainSort.key === 'tvs' || chainSort.key === 'stage';
    const showIncident = chainIncidentOnly || incidentColLatched || state.openByChain.size > 0;
    if (showIncident) incidentColLatched = true;
    // If the sort key's column is being hidden, fall back to the default
    // order — a table silently sorted by an invisible column is a puzzle.
    if (!showIncident && chainSort.key === 'incident') {
        chainSort = { key: 'chainId', dir: 1 };
        syncChainSortHeaders();
    }
    const table = byId('chainsTable');
    table?.classList.toggle('cols-l2b-off', !showL2b);
    table?.classList.toggle('cols-incident-off', !showIncident);
    const visibleCols = 8 - (showL2b ? 0 : 2) - (showIncident ? 0 : 1);

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
            el('td', { colspan: String(visibleCols), class: 'cell-primary' }, [el('div', {
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
                : el('span', { class: 'dim', text: '—' })], { empty: !r.stage, cls: 'col-l2b' }),
            td('Value secured', [r.tvs != null ? fmtUsd(r.tvs) : '—'], { num: true, empty: r.tvs == null, cls: 'col-l2b' }),
            td('RPCs', [r.rpcs ? fmtNum(r.rpcs) : '—'], { num: true, empty: !r.rpcs }),
            td('Status', [el('span', { class: `pill pill-${r.status}`, text: r.status })]),
            td('Incident', [incidentCell], { empty: !r.openCount, cls: 'col-incident' })
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

    // A severity filter whose only non-empty bucket is "Not classified" cannot sort anything,
    // so hide the labelled group entirely. Keyed on what is actually classified rather than on
    // the feed's `hello` flag: a feed that has switched its classifier OFF can still be
    // serving events classified while it was on, and those stay filterable.
    const group = wrap.closest('.toolbar-group');
    if (![...counts.keys()].some(k => k !== 'none')) {
        incidents.severity = 'all';
        group?.classList.add('hidden');
        return;
    }
    group?.classList.remove('hidden');
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
    // 'unknown' only ever appears once the feed sends a level outside the scale, so it is
    // invisible until there is drift and unmissable the moment there is.
    for (const key of ['critical', 'major', 'minor', 'unknown', 'none']) {
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
    // The same predicate the card gates on. Counting mere presence here is what let the strip
    // claim an event was classified while the card below it said otherwise.
    const enriched = all.filter(it => hasClassification(enrichmentOf(it))).length;
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
    // Three distinct states, and 0% used to stand for all of them. "off" is a claim about the
    // pipeline and only the feed's `hello` frame can make it; a rate is a claim about the
    // events. A feed that has switched its classifier off mid-life is both at once — it still
    // serves what it classified earlier — so that case keeps the real rate and says the rest.
    const classifierOff = incidents.enrichmentAvailable === false;
    const rate = all.length ? Viz.fmtPct((enriched / all.length) * 100, 0) : '—';
    wrap.appendChild(statTile({
        label: 'AI classified',
        value: classifierOff && !enriched ? 'off' : rate,
        sub: classifierOff
            ? (enriched
                ? `${fmtNum(enriched)} of ${fmtNum(all.length)} events · no new ones`
                : 'classifier disabled upstream')
            : `${fmtNum(enriched)} of ${fmtNum(all.length)} events`,
        hint: classifierOff
            ? 'The status feed is relaying events without classifying them, so no further event can gain a severity. This is a setting on that service, not a fault here.'
            : 'Share of events with an LLM classification from the feed. Unclassified events are never given a guessed severity.'
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

// The lifecycle of one incident: a row per state the feed published, down → recovered.
// Suppressed below two steps, where there is no lifecycle to show — just a single state.
function incidentTimeline(it) {
    const steps = it.transitions;
    if (!Array.isArray(steps) || steps.length < 2) return null;
    // Atlassian incidents keep ONE title across every update, so stripping the shared
    // subject would leave the same single word on every row ("errors", "errors", …).
    // When the titles never change, the STATUS is what changed.
    const first = (steps[0].title || '').trim().toLowerCase();
    const uniformTitle = steps.every(step => (step.title || '').trim().toLowerCase() === first);
    const startedDay = new Date(steps[0].ms).toDateString();
    const rows = steps.map((step, i) => {
        const prev = i > 0 ? steps[i - 1] : null;
        // Elapsed since the PREVIOUS step, so a long gap between "identified" and
        // "resolved" is visible rather than buried in two absolute timestamps.
        const gap = prev ? fmtDuration(step.ms - prev.ms) : null;
        const when = new Date(step.ms);
        // A multi-day incident would otherwise show two bare clock times three days apart
        // and read as an hour.
        const sameDay = when.toDateString() === startedDay;
        const stamp = sameDay
            ? when.toLocaleTimeString()
            : `${when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${when.toLocaleTimeString()}`;
        const label = uniformTitle
            ? (step.status || step.title || '—')
            : stripLifecycleSubject(step.title, it.openedTitle);
        const token = statusToken(step.status);
        return el('li', { class: 'tl-step' }, [
            el('span', { class: `tl-dot${token ? ` st-${token}` : ''}` }),
            el('span', { class: 'tl-time', text: stamp }),
            el('span', { class: 'tl-label', text: label }),
            gap ? el('span', { class: 'tl-gap', text: `+${gap}` }) : null
        ]);
    });
    return el('ul', { class: 'incident-timeline' }, rows);
}

// The steps of one incident usually repeat its subject ("Portal went down", "Portal
// recovered"); the card headline already carries it, so show only what changed. Falls
// back to the full title when there is no shared prefix to strip.
function stripLifecycleSubject(title, openedTitle) {
    const text = (title || '').trim();
    if (!text || !openedTitle) return text || '—';
    const words = openedTitle.trim().split(/\s+/);
    // Longest shared leading word run, so "Superposition Testnet RPC went down" and
    // "… recovered" both reduce to their verb without hard-coding any vocabulary.
    const own = text.split(/\s+/);
    let shared = 0;
    while (shared < words.length && shared < own.length - 1 && words[shared].toLowerCase() === own[shared].toLowerCase()) shared++;
    return shared > 0 ? own.slice(shared).join(' ') : text;
}

// One card builder for chain, coin and provider incidents.
function incidentCard(it) {
    const enr = enrichmentOf(it);
    const sev = severityOf(it);
    const open = isOpen(it);
    const dur = durationInfo(it);
    // When it STARTED, not when it last changed. Pairing the opening headline below with the
    // newest event's timestamp produced "Portal went down · 7:58:10 PM" where 7:58 was the
    // moment it came back; the lifecycle strip is what carries the later steps.
    const when = fmtDateTime(it.firstSeen ?? it.whenMs);
    // The opening event's title. The newest event wins for current state, but a card
    // headlined "Portal recovered" describes the end of the story rather than the incident.
    const headline = it.openedTitle || it.title;

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
                    ? el('a', { href: safeUrl(it.url), target: '_blank', rel: 'noopener', text: headline })
                    : el('span', { text: headline })
            ])
        ]),
        el('div', { class: 'incident-meta', text: meta.join(' · ') }),
        // Published states before anything the model inferred: what the operator actually
        // said outranks a classification of it.
        incidentTimeline(it)
    ]);

    // ── AI enrichment, fully attributed ──
    main.appendChild(hasClassification(enr) ? aiBlock(enr) : el('div', {
        class: 'ai-unclassified',
        // Which of the two silences this is. "Nothing classified this event" and "nothing can
        // classify anything right now" send the reader to different places.
        text: incidents.enrichmentAvailable === false
            ? 'The status feed is running as a pure relay right now, so no AI classification is available and none is implied.'
            : 'Not classified by the AI pipeline — severity unknown.'
    }));

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

// Is there a classification here at all? Deliberately NOT "does it have a summary": the
// severity badge, the severity filter and the "AI classified" stat all key off the presence
// of the enrichment object, so gating the body on `summary` alone produced cards whose side
// badge read "Critical" while the body underneath read "Not classified — severity unknown",
// counted all the while as classified in the stat above. Summary-less enrichments are a real
// shape in this system, not a hypothetical: the server-side reader strips `summary`
// deliberately to keep it out of the assistant's context window.
function hasClassification(enr) {
    if (!enr) return false;
    if (enr.class || enr.summary || enr.lowConfidence || enr.context?.actionRequired) return true;
    // A severity counts only where it says something. An explicit "none" grade carrying
    // nothing else is the absence of a classification, not a classification of absence.
    return Boolean(enr.severity) && severityMeta(enr.severity).key !== 'none';
}

// Producers disagree on scale — some report 0–1, some 0–100. Normalise, then clamp: the bar
// is a percentage width, so an unclamped 0–100 producer rendered "8500%" and overflowed it.
function normalizeConfidence(v) {
    if (!Number.isFinite(v)) return null;
    return Math.min(1, Math.max(0, v > 1 ? v / 100 : v));
}

// The severity as a head label, for a classification that carries no class. Attributing the
// side badge to the model is the point — nothing else on the card says the badge is inferred.
function aiSeverityLabel(enr) {
    if (!enr.severity) return null;
    const meta = severityMeta(enr.severity);
    return meta.key === 'none' ? null : el('span', { class: 'ai-class', text: meta.label });
}

// Every part is independent, because the feed sends them independently.
function aiBlock(enr) {
    const head = el('div', { class: 'ai-head' }, [
        el('span', { class: 'ai-tag', text: 'AI' }),
        // Falling back to the severity keeps the head from rendering as a bare "AI" tag, and
        // it attributes the side badge: that badge is the model's reading, not the operator's,
        // and nothing else on the card says so.
        enr.class
            ? el('span', { class: 'ai-class', text: String(enr.class).replace(/_/g, ' ') })
            // …but not when that label is "Not classified": a feed that explicitly grades an
            // event as no-severity would otherwise render the head as "AI · Not classified".
            : aiSeverityLabel(enr)
    ]);
    // Upstream flags a substantial share of classifications as low-confidence — mostly class
    // `other` — and the server-side reader carries the flag for exactly this reason: printing
    // the label without the caveat is how a guess becomes an assertion. This surface dropped
    // it on the floor and showed those classifications as fact.
    if (enr.lowConfidence === true) {
        head.appendChild(el('span', {
            class: 'ai-lowconf',
            title: 'The model reported low confidence in this classification. Treat it as a guess, not a finding.',
            text: 'low confidence'
        }));
    }
    const conf = normalizeConfidence(enr.confidence);
    if (conf != null) {
        const pct = Math.round(conf * 100);
        const bar = el('span', { class: 'ai-conf-bar' }, [el('span', { class: 'ai-conf-fill' })]);
        bar.firstChild.style.width = `${pct}%`;
        head.appendChild(el('span', { class: 'ai-conf', title: 'Model-reported confidence in this classification' }, [
            'confidence ', bar, `${pct}%`
        ]));
    }

    const block = el('div', { class: 'ai-block' }, [head]);
    if (enr.summary) block.appendChild(el('div', { class: 'ai-summary', text: plainText(enr.summary) }));
    const action = enr.context?.actionRequired;
    if (action && String(action).toLowerCase() !== 'none') {
        block.appendChild(el('div', { class: 'ai-action' }, [
            el('span', { class: 'ai-action-label', text: 'Action:' }),
            el('span', { text: String(action) })
        ]));
    }
    return block;
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
            || it.openedTitle?.toLowerCase().includes(searchQuery)
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
    if (it.spName?.toLowerCase().includes(q) || it.title?.toLowerCase().includes(q)
        || it.openedTitle?.toLowerCase().includes(q)) return true;
    if ((it.affectedComponents || []).some(c => c.toLowerCase().includes(q))) return true;
    return it.chainIds.some(id => String(id).includes(q) || state.byId.get(id)?.name?.toLowerCase().includes(q));
}

function initProviderControls() { /* chips are generated in renderProviderFilter */ }

function renderProviders() {
    renderProviderStats();
    renderProviderBoard();
    renderProviderFilter();
    renderProviderHistogram();
    renderProviderCalendar();
    renderProviderList();
}

// ─── Provider performance board (GET /providers/stats) ───────────────────
// A comparison table, not ten cards. Cards force every provider to occupy equal space and
// to show a value for every metric, so nine of ten render as a column of em-dashes; a table
// lets one glance rank providers on whichever column the reader cares about, and lets a
// missing value simply be missing.
//
// Two ideas the design has to carry, or the numbers mislead:
//
//   self-reported   Every figure comes from the provider's OWN status page. A provider that
//                   posts nothing scores a silent 100%. Rows whose page publishes no
//                   incident history are marked and sink below the comparable ones instead
//                   of topping the ranking.
//   disclosure bias Incident COUNTS are editorial policy, not reliability — one provider
//                   posts 19 maintenance windows and 1 incident where another posts 19
//                   incidents. The count column says so rather than implying a ranking.
//
// 404 → an older API without the endpoint → the board simply stays hidden.
const providerBoard = { data: null, sort: 'availability', dir: 1 };

async function loadProviderStats() {
    let data;
    try { data = await api('/providers/stats'); } catch { return; }
    providerBoard.data = data;
    if (activeView === 'providers') renderProviderBoard();
}

// `when` decides whether a column earns its width: a column no provider can populate is
// 12% of the table spent on a stack of em-dashes. Time-to-resolve is the live example —
// resolution transitions are almost never published, so it appears only once some page
// actually exposes one.
const PB_COLUMNS = [
    { key: 'name', label: 'Provider', primary: true },
    { key: 'availability', label: 'Availability', title: 'Chain-weighted: 1 − chain-hours lost ÷ (chains supported × window). Counts only incidents whose duration the page published.' },
    { key: 'lost', label: 'Chain-hours lost', title: 'Chains affected × hours down, overlaps merged per chain. Available even when the availability denominator is not.' },
    { key: 'chains', label: 'Chains', title: 'How many chains the provider’s own status page lists. This is the availability denominator.' },
    { key: 'incidents', label: 'Posted', title: 'Incidents / maintenance windows published in the observed window. Disclosure policy differs sharply between providers — do not read this as a reliability ranking.' },
    { key: 'openfor', label: 'Longest open', title: 'How long the provider’s oldest still-open incident has been running. With resolution times unpublished, this is the one duration the feeds do expose.', when: ps => ps.some(p => p.oldestOngoingAt) },
    { key: 'mttr', label: 'Time to resolve', title: 'Median hours from the first update to the resolved update, over the incidents where the page actually showed both.', when: ps => ps.some(p => p.resolutionHours) },
    { key: 'trend', label: 'Daily trend', title: 'Chain-hours lost per day, one bucket per day over 30 days. Buckets older than the observed history are empty rather than zero.' }
];

function renderProviderBoard() {
    const host = byId('providerBoard');
    if (!host) return;
    const data = providerBoard.data;
    const provs = data?.providers || [];
    host.textContent = '';
    if (!provs.length) { host.hidden = true; return; }
    host.hidden = false;

    // The observed window, not a fixed 30: the server reports how much history it actually
    // has, and it is routinely half of what the field names suggest.
    const days = Math.round(data.windowDays ?? 30);
    const comparable = provs.filter(p => p.disclosure?.comparable !== false);
    const partial = provs.filter(p => p.disclosure?.comparable === false);

    host.appendChild(providerBoardCaption(data, provs, days));

    const columns = PB_COLUMNS.filter(c => !c.when || c.when(provs));
    const table = el('table', { class: 'data-table data-table--stack pb-table' });
    table.appendChild(el('colgroup', {}, columns.map(c => el('col', { class: `c-${c.key}` }))));
    table.appendChild(el('thead', {}, [el('tr', {}, columns.map(c => {
        const active = providerBoard.sort === c.key;
        return el('th', {
            class: [c.primary ? 'pb-left' : '', active ? 'pb-sorted' : '', c.key === 'trend' ? 'pb-trend-h' : '']
                .filter(Boolean).join(' ') || null,
            title: c.title || null,
            'aria-sort': active ? (providerBoard.dir > 0 ? 'descending' : 'ascending') : 'none'
        }, [
            el('button', {
                class: 'pb-sort-btn',
                text: c.label + (active ? (providerBoard.dir > 0 ? ' ↓' : ' ↑') : ''),
                onclick: () => {
                    if (providerBoard.sort === c.key) providerBoard.dir *= -1;
                    else { providerBoard.sort = c.key; providerBoard.dir = 1; }
                    renderProviderBoard();
                }
            })
        ]);
    }))]));

    const body = el('tbody');
    for (const p of sortProviders(comparable)) body.appendChild(providerRow(p, columns));
    if (partial.length) {
        // Below a divider rather than interleaved: a page that publishes nothing must not be
        // able to top a ranking built from what pages publish.
        const many = partial.length !== 1;
        body.appendChild(el('tr', { class: 'pb-divider' }, [
            el('td', { colspan: String(columns.length) }, [
                el('span', {
                    text: `Not comparable — ${many ? 'these pages do' : 'this page does'} not publish the chain list or any `
                        + `incident history, so availability can’t be computed from ${many ? 'them' : 'it'}.`
                })
            ])
        ]));
        for (const p of sortProviders(partial)) body.appendChild(providerRow(p, columns));
    }
    table.appendChild(body);
    host.appendChild(el('div', { class: 'table-wrap' }, [table]));
}

function providerBoardCaption(data, provs, days) {
    const withCoverage = provs.filter(p => p.chainsSupported != null).length;
    const ongoing = provs.reduce((n, p) => n + (p.ongoingNow || 0), 0);
    const inMaint = provs.reduce((n, p) => n + (p.ongoingMaintenance || 0), 0);
    // How much of the incident history had a duration at all. Most status pages publish an
    // incident exactly once, at resolution, so its start — and therefore its cost — is
    // unknowable. Those are excluded from availability rather than guessed, and a reader has
    // to know that before ranking on it.
    const measured = provs.reduce((n, p) => n + (p.availability?.measuredIncidents || 0), 0);
    const unknown = provs.reduce((n, p) => n + (p.availability?.unknownDurationIncidents || 0), 0);
    return el('div', { class: 'pb-caption' }, [
        el('div', { class: 'pb-caption-head' }, [
            el('h3', { class: 'card-title', text: 'Provider performance' }),
            ongoing > 0
                ? el('span', { class: 'pill pill-ongoing', text: `${ongoing} incident${ongoing === 1 ? '' : 's'} open now` })
                : el('span', { class: 'pill pill-quiet', text: 'no open incidents' }),
            inMaint > 0 ? el('span', { class: 'pill pill-maint', text: `${inMaint} maintenance running` }) : null
        ]),
        // Both caveats stay — they are what stops the table being misread — but as scannable
        // lines rather than paragraphs, with the reasoning on hover like every other hint
        // here. Ninety words of permanent disclaimer is a disclaimer nobody reads.
        el('p', { class: 'pb-caption-note' }, [
            el('strong', { text: 'Self-reported' }),
            el('span', {
                title: `Every figure comes from each provider’s own status page over the last ${days} days, so a`
                    + ' provider that posts nothing scores a silent 100%. The chain list is the availability'
                    + ' denominator — pages that publish none get no percentage rather than an invented one, and'
                    + ' sit below the divider.',
                text: ` · last ${days} days · ${withCoverage} of ${provs.length} pages list their chains`
            })
        ]),
        // Conditional: an always-on disclaimer trains readers to skip it.
        unknown > 0 ? el('p', { class: 'pb-caption-note' }, [
            el('strong', { class: 'pb-warn', text: 'Read availability narrowly' }),
            el('span', {
                title: `Only ${measured} of ${measured + unknown} incidents published enough to time them; the rest`
                    + ' appear once, at resolution, with no start. Those are left out of the percentage rather than'
                    + ' charged as downtime, so availability mostly reflects what is burning right now. Incident'
                    + ' counts are complete, but they measure disclosure policy as much as reliability.',
                text: ` · ${measured} of ${measured + unknown} incidents could be timed`
            })
        ]) : null
    ]);
}

function sortProviders(list) {
    const val = p => {
        switch (providerBoard.sort) {
            case 'availability': return p.availability?.last30d?.percent ?? -1;
            case 'lost': return p.availability?.last30d?.chainHoursLost ?? -1;
            case 'chains': return p.chainsSupported ?? -1;
            case 'incidents': return p.incidents30d ?? -1;
            case 'mttr': return p.resolutionHours?.median ?? -1;
            case 'openfor': return p.oldestOngoingAt ? Date.now() - Date.parse(p.oldestOngoingAt) : -1;
            case 'trend': return p.availability?.last7d?.chainHoursLost ?? -1;
            default: return null;
        }
    };
    return [...list].sort((a, b) => {
        if (providerBoard.sort === 'name') return (a.name || a.id).localeCompare(b.name || b.id) * providerBoard.dir;
        // Availability sorts best-first by default, which means DESCENDING; every other
        // column is "more is more", so one shared direction flag works. Missing values are
        // -1 so they sink under a descending sort instead of leading it.
        const d = (val(b) - val(a)) * providerBoard.dir;
        return d || (a.name || a.id).localeCompare(b.name || b.id);
    });
}

function providerRow(p, columns) {
    const a = p.availability || {};
    const pct = a.last30d?.percent;
    const lost = a.last30d?.chainHoursLost;
    const d = p.disclosure || {};
    const has = key => columns.some(c => c.key === key);

    // Availability cell: the headline, with 24h/7d underneath so a provider that is bad
    // RIGHT NOW cannot hide behind a good month.
    const availCell = pct == null
        ? td('Availability', [
            el('span', { class: 'pb-dash', text: '—' }),
            // WHICH reason, not a bare dash: no denominator and no incidents are different
            // states and the reader can act on the difference.
            el('span', { class: 'pb-sub', text: p.chainsSupported == null ? 'no chain list published' : 'no incidents posted' })
        ], { num: true, cls: 'pb-avail pb-none' })
        : td('Availability', [
            el('div', { class: 'pb-avail-main' }, [
                el('span', { class: `pb-dot ${availClass(pct)}` }),
                el('span', { class: 'pb-pct mono', text: `${pbPct(pct)}%` }),
                el('span', { class: 'pb-bar' }, [
                    // Deviation from 100 is the signal and it is tiny, so the bar scales the
                    // LOSS across a 3% floor rather than the value — a 0–100 bar would render
                    // every provider as a full bar.
                    el('span', {
                        class: `pb-bar-fill ${availClass(pct)}`,
                        style: { width: `${Math.min(100, ((100 - pct) / 3) * 100).toFixed(1)}%` }
                    })
                ])
            ]),
            el('span', {
                class: 'pb-sub',
                // A 100% built from zero timed incidents means "nothing open", not "a clean
                // month" — say which, or the column overstates.
                text: a.measuredIncidents ? `24h ${pbPct(a.last24h?.percent)}% · 7d ${pbPct(a.last7d?.percent)}%` : 'nothing open · none timed'
            })
        ], { num: true, cls: 'pb-avail' });

    return el('tr', { class: `pb-row${p.ongoingNow > 0 ? ' pb-ongoing' : ''}` }, [
        td('Provider', [
            el('span', { class: 'pb-name-main', text: p.name || p.id }),
            p.ongoingNow > 0 ? el('span', { class: 'pill pill-ongoing sm', text: `${p.ongoingNow} ongoing` }) : null,
            // Red is reserved for real incidents. A window running to schedule is planned
            // work and gets a neutral chip, not an alarm.
            p.ongoingMaintenance > 0
                ? el('span', { class: 'pill pill-maint sm', title: 'Scheduled maintenance in progress — planned, not an outage.', text: `${p.ongoingMaintenance} in maintenance` })
                : null,
            !d.publishesChainCoverage
                ? el('span', { class: 'pb-flag', title: 'This status page exposes no machine-readable chain list, so no availability denominator exists.', text: 'no coverage' })
                : null
        ], { primary: true, cls: 'pb-name' }),
        availCell,
        td('Chain-hours lost', [
            el('span', { class: 'mono', text: lost == null ? '—' : pb1(lost) }),
            lost ? el('span', { class: 'pb-sub', text: `${pb1(a.last24h?.chainHoursLost || 0)} in 24h` }) : null
        ], { num: true, empty: lost == null }),
        td('Chains', [
            el('span', { class: 'mono', text: p.chainsSupported == null ? '—' : String(p.chainsSupported) }),
            p.chainsAffected30d ? el('span', { class: 'pb-sub', text: `${p.chainsAffected30d} hit` }) : null
        ], { num: true, empty: p.chainsSupported == null }),
        td('Posted', [
            el('span', { class: 'mono', text: `${p.incidents30d ?? 0} inc` }),
            el('span', { class: 'pb-sub', text: p.maintenance30d ? `${p.maintenance30d} maint` : 'no maintenance posted' })
        ], { num: true }),
        ...(has('openfor') ? [td('Longest open', openForCell(p), { num: true, empty: !p.oldestOngoingAt })] : []),
        ...(has('mttr') ? [td('Time to resolve', mttrCell(p), { num: true })] : []),
        td('Daily trend', [
            p.dailySeries?.length
                ? sparkline(p.dailySeries.map(b => b.chainHoursLost), 96, 26)
                : el('span', { class: 'pb-sub', text: '—' })
        ], { num: true, cls: 'pb-trend', empty: !p.dailySeries?.length })
    ]);
}

// The age of the oldest still-open incident. A provider sitting on a 12-day-old unresolved
// outage and one that opened a ticket an hour ago post the same "1 ongoing"; only this
// column tells them apart.
function openForCell(p) {
    if (!p.oldestOngoingAt) return [el('span', { class: 'pb-dash', text: '—' })];
    const ms = Date.now() - Date.parse(p.oldestOngoingAt);
    return [
        el('span', { class: `mono${ms > 7 * 864e5 ? ' pb-stale' : ''}`, text: fmtDuration(ms) || '—' }),
        el('span', { class: 'pb-sub', text: p.ongoingNow > 1 ? `oldest of ${p.ongoingNow}` : 'still open' })
    ];
}

// MTTR is only as good as the share of incidents where the page showed an open→resolved
// transition. Most publish a history feed carrying the resolved entry alone, so the sample
// is often 1-of-16 — printing a bare "22.6h" there would be a confident lie. The sample size
// travels with the number.
function mttrCell(p) {
    const r = p.resolutionHours;
    if (!r?.median && r?.median !== 0) {
        return [el('span', { class: 'pb-dash', text: '—' }), el('span', { class: 'pb-sub', text: 'not tracked' })];
    }
    const share = p.disclosure?.resolutionTracked ?? 0;
    return [
        el('span', { class: 'mono', text: `${pb1(r.median)}h` }),
        el('span', {
            class: `pb-sub${share < 0.3 ? ' pb-thin' : ''}`,
            title: share < 0.3 ? 'Small sample — most of this page’s incidents never showed an opening update.' : null,
            text: `${r.samples} of ${p.incidents30d ?? 0}`
        })
    ];
}

// Inline sparkline. Areas read as volume at this size where a polyline reads as noise, so
// the shape is filled; an all-zero series draws a flat baseline rather than vanishing,
// because "no downtime" is a result worth seeing.
//
// This is decoration and is marked aria-hidden: the numbers behind it are not reachable from
// the shape, and the columns beside it carry the values that matter. It is deliberately not
// a Viz chart — those all ship axes and a table twin, which is the right rule for a chart
// someone reads values off and the wrong shape for a 96×26 glyph in a table cell.
function sparkline(values, w, h) {
    const peak = Math.max(...values, 0);
    const n = values.length;
    const step = w / Math.max(1, n - 1);
    const y = v => (peak <= 0 ? h - 1.5 : h - 1.5 - (v / peak) * (h - 4));
    const pts = values.map((v, i) => `${(i * step).toFixed(1)},${y(v).toFixed(1)}`);
    return Viz.svgEl('svg', { viewBox: `0 0 ${w} ${h}`, width: String(w), height: String(h), class: 'pb-spark', 'aria-hidden': 'true' }, [
        Viz.svgEl('path', { d: `M0,${h} L${pts.join(' L')} L${w},${h} Z`, class: 'pb-spark-fill' }),
        Viz.svgEl('path', { d: `M${pts.join(' L')}`, class: 'pb-spark-line', fill: 'none', 'vector-effect': 'non-scaling-stroke' })
    ]);
}

// Availability lives near 100, so the thresholds are tight — a 97% month means a
// chain-equivalent was down for most of a day.
//
// THREE tones, not four. The version this came from had a fourth tier between good and warn
// (99–99.9), but no four-tone green→amber→red ramp clears the validator's normal-vision
// separation floor: every candidate put two tones ~10 ΔE apart in the yellow-green region,
// which full-colour readers cannot reliably tell apart and a direct label does not excuse.
// The 2-decimal percentage sits beside every dot and distinguishes 99.94 from 99.5 far
// better than a colour no one can name, so the tier was dropped rather than faked.
function availClass(pct) { return pct == null ? '' : pct >= 99.9 ? 'good' : pct >= 97 ? 'warn' : 'bad'; }
// Deliberately NOT Viz.fmtPct: that one appends the sign and rounds to 1dp, and the second
// decimal is the entire signal this close to 100 — 99.94 and 99.90 are a 17× difference in
// downtime. Callers append the % themselves.
function pbPct(v) { return v == null ? '—' : String(Math.round(v * 100) / 100); }
function pb1(v) { return v == null ? '—' : String(Math.round(v * 10) / 10); }

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
                            el('a', { href: safeUrl(p.url), target: '_blank', rel: 'noopener', text: p.title })
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
    document.documentElement.classList.remove('drawer-open');
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
                            it.url ? el('a', { href: safeUrl(it.url), target: '_blank', rel: 'noopener', text: it.openedTitle || it.title })
                                : el('span', { text: it.openedTitle || it.title })
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
            el('a', { href: safeUrl(sp.url), target: '_blank', rel: 'noopener', text: safeHost(sp.url) || sp.name })));
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
    // Lock the page behind the drawer. Without this the background keeps scrolling under a
    // full-width mobile drawer, which is disorienting on its own and also parks the chains
    // table's sticky header mid-viewport — where a mobile compositor can paint it OVER the
    // drawer, reported from Samsung Internet with the ID/NAME/TYPE row floating across an
    // incident card. The CSS also neutralises those sticky headers while this class is set,
    // so the overlap cannot happen even on a browser that composites sticky above fixed.
    document.documentElement.classList.add('drawer-open');
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
    // Market figures exist for only ~29 chains, and rollups are mapped to their settlement
    // token — so every row here is labelled with the ASSET it describes, never as a property
    // of the chain. Base and Arbitrum both show ETH's volume, which is correct and would be
    // badly misleading under a bare "Volume" label.
    if (typeof d.price?.usd === 'number') {
        const sym = d.nativeCurrency?.symbol || 'token';
        const p = d.price;
        // A quote CoinGecko has not moved in over a day is not a current market. Say when it
        // stopped rather than presenting a dead number as live — three of the mapped assets
        // were months stale when this was written.
        const asOfText = p.asOf ? relTime(p.asOf) : null;
        const staleNote = p.stale
            ? ` Upstream stopped updating this quote ${asOfText} — it is not a current market.`
            : '';
        box.appendChild(detailRow(`${sym} price`, el('span', {
            class: p.stale ? 'dim' : null,
            title: `${sym} spot price from CoinGecko${p.asOf ? `, last moved ${asOfText}` : ''}.`
                + ` Read ${relTime(p.updatedAt)}. Rollups are mapped to their settlement token.${staleNote}`,
            text: `$${p.usd.toLocaleString()}${p.stale ? ` · stale (${asOfText})` : ''}`
        })));
        // 24h volume is the ASSET's trading activity, not the chain's throughput. A stale
        // quote arrives with this already nulled by the service, so absence here means
        // "no current figure" and needs no second staleness check.
        if (typeof p.vol24h === 'number') {
            box.appendChild(detailRow(`${sym} 24h volume`, el('span', {
                title: `Trading volume of ${sym} across exchanges over the last 24 hours, from CoinGecko`
                    + `${p.asOf ? ` (last moved ${asOfText})` : ''}. This is market activity for the asset —`
                    + ' not this chain\u2019s transaction count or throughput. Chains that share a settlement'
                    + ' token report the same figure.',
                text: Viz.fmtUsd(p.vol24h)
            })));
        }
        if (typeof p.marketCap === 'number') {
            box.appendChild(detailRow(`${sym} market cap`, el('span', {
                title: `Circulating market capitalisation of ${sym}, from CoinGecko. A property of the asset,`
                    + ' not of this chain.',
                text: Viz.fmtUsd(p.marketCap)
            })));
        }
    }
    if (d.explorers?.length) {
        box.appendChild(detailRow('Explorers', d.explorers.slice(0, 6).map(x =>
            el('a', { href: safeUrl(x.url), target: '_blank', rel: 'noopener', text: x.name || safeHost(x.url) }))));
    }
    if (d.infoURL) {
        box.appendChild(detailRow('Website',
            el('a', { href: safeUrl(d.infoURL), target: '_blank', rel: 'noopener', text: safeHost(d.infoURL) || d.infoURL })));
    }
    if (d.forumUrl) {
        box.appendChild(detailRow('Forum',
            el('a', { href: safeUrl(d.forumUrl), target: '_blank', rel: 'noopener', text: safeHost(d.forumUrl) || d.forumUrl })));
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
                el('a', { href: safeUrl(p.url), target: '_blank', rel: 'noopener', text: p.title }),
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
        // Assign the var() itself, not its resolved hex: an inline literal
        // freezes the theme it was computed under, and nothing re-probes the
        // assistant when the reader toggles themes.
        meta.style.color = online ? 'var(--good-text)' : 'var(--critical-text)';
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
    renderAssistantMarkdown(text, body);
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

// Minimal markdown for assistant replies, built as DOM NODES rather than an HTML string.
//
// This used to assemble markup by hand and assign innerHTML, escaping &<>" first. That escaping
// was correct as far as I could reason about it, but it left model output one regex edit away
// from XSS, and CodeQL flagged the sink (js/xss, high). createTextNode cannot execute anything,
// so the bug class is removed rather than guarded: there is no HTML string left to get wrong.
//
// Supports: `code`, **bold**, bullet lists, bare http(s) URLs, paragraphs.
function renderAssistantMarkdown(text, target) {
    for (const block of String(text).split(/\n{2,}/)) {
        const lines = block.split('\n');
        const isList = lines.every(line => /^\s*[-*] /.test(line) || line.trim() === '');
        if (isList && lines.some(line => line.trim())) {
            const ul = document.createElement('ul');
            for (const line of lines.filter(l => l.trim())) {
                const li = document.createElement('li');
                appendInlineMd(li, line.replace(/^\s*[-*] /, ''));
                ul.appendChild(li);
            }
            target.appendChild(ul);
            continue;
        }
        const p = document.createElement('p');
        lines.forEach((line, i) => {
            if (i) p.appendChild(document.createElement('br'));
            appendInlineMd(p, line);
        });
        target.appendChild(p);
    }
}

// One pass over the alternatives, so a span produced by one rule is never rescanned by another —
// the old chained .replace() calls could reprocess their own output.
const INLINE_MD = /`([^`]+)`|\*\*([^*]+)\*\*|(https?:\/\/[^\s<)]+)/g;
function appendInlineMd(target, text) {
    const source = String(text);
    let last = 0;
    for (const m of source.matchAll(INLINE_MD)) {
        if (m.index > last) target.appendChild(document.createTextNode(source.slice(last, m.index)));
        if (m[1] != null) {
            const code = document.createElement('code');
            code.textContent = m[1];
            target.appendChild(code);
        } else if (m[2] != null) {
            const strong = document.createElement('strong');
            strong.textContent = m[2];
            target.appendChild(strong);
        } else {
            // Same protocol rule as every other link on the page; a non-http(s) match stays text.
            const href = safeUrl(m[3]);
            if (href) {
                const a = document.createElement('a');
                a.href = href;
                a.target = '_blank';
                a.rel = 'noopener';
                a.textContent = m[3];
                target.appendChild(a);
            } else {
                target.appendChild(document.createTextNode(m[3]));
            }
        }
        last = m.index + m[0].length;
    }
    if (last < source.length) target.appendChild(document.createTextNode(source.slice(last)));
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
    const sev = severityMeta(enr?.severity);
    const when = s.whenMs ? relTime(new Date(s.whenMs).toISOString()) : null;
    const publishers = s.sources.map(x => x.name || x.id).filter(Boolean);

    const main = el('div', { class: 'incident-main' }, [
        el('div', { class: 'incident-title' }, [
            s.articleCount > 1
                ? el('span', { class: 'kind-tag', title: `Reported by ${s.articleCount} sources`, text: `${s.articleCount}×` })
                : null,
            el('span', { class: 'incident-title-text' }, [
                s.url
                    ? el('a', { href: safeUrl(s.url), target: '_blank', rel: 'noopener', text: s.title })
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
        main.appendChild(el('div', { class: 'ai-summary', style: 'margin-top:6px', text: Viz.truncate(plainText(s.summary), 260) }));
    }

    // AI classification, attributed exactly like the incident cards.
    if (enr?.class || enr?.summary) {
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

        const block = el('div', { class: 'ai-block' }, [head]);
        if (enr.summary && enr.summary !== s.summary) {
            block.appendChild(el('div', { class: 'ai-summary', text: plainText(enr.summary) }));
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
            ? el('span', { class: `sev sev-${sev.key}` }, [el('span', { class: 'sev-mark' }), sev.label])
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

// ═══ Timeline view (GET /upgrades) ══════════════════════════════════════════
// Scheduled network upgrades and maintenance windows on one time axis, with the incidents
// that followed an activation attached to it. Ported from the pre-rebuild dashboard; the
// SVG helper, the DOM accessor and the link gating are this file's, and the per-network
// avatar it used does not exist in this design, so the row names its network as a chain
// chip instead.
// ─────────────────────────────── Timeline (upgrades ↔ fallout ↔ coverage) ───────────────────────────────
// An activity view over the API's /upgrades correlation layer, not a list of
// cards: a density chart across a real time axis with NOW in it, so pending
// windows and recent history read as one continuous picture, then a dense row
// list underneath. The previous centre-spine layout fitted eleven windows in a
// 2400px viewport and put every scheduled window in a column headed "Recent".
//
// The chart's x-domain deliberately extends into the FUTURE — this feed's whole
// point is that ten upgrades are pending — and the future half is drawn hatched
// so "scheduled" never reads as "happened".
const timeline = {
    upgrades: [], loaded: false, loading: false, error: null, ticker: null,
    stream: 'all', rangeDays: 7, sort: 'time',
    // Domain + bucketing of the chart as last drawn, read by the hover layer.
    hover: null
};

// Range presets. Each spans backwards `days` and forwards far enough to hold the
// pending windows, capped so one distant window can't flatten the recent detail.
const TL_RANGES = [
    ['1D', 1], ['7D', 7], ['30D', 30], ['All', 0]
];

// How well the feed knows when a window runs. A countdown, a position on the time axis and
// a sort are only meaningful for the dated levels — 'announced' means the provider said an
// upgrade is coming and never named the day, so it gets its own group rather than a fake time.
const TL_EVIDENCE = {
    window: { label: 'exact window', cls: 'ev-exact', title: 'The provider stated the window start (and usually its end).' },
    scheduled: { label: 'scheduled', cls: 'ev-exact', title: 'A scheduled entry set the start time.' },
    started: { label: 'observed start', cls: 'ev-approx', title: 'Seen in progress — the run had begun by this time.' },
    completed: { label: 'completed by', cls: 'ev-approx', title: 'Only a completion post exists: an upper bound on the run, not its start.' },
    announced: { label: 'date not announced', cls: 'ev-unknown', title: 'Announced with no date. The provider has not said when it runs.' }
};
function evidenceOf(u) { return TL_EVIDENCE[u.activationEvidence] ?? TL_EVIDENCE.announced; }
function isDated(u) { return timelineActivationMs(u) != null; }

const TL_STREAMS = [
    ['all', 'All windows'],
    ['upcoming', 'Upcoming'],
    ['undated', 'Date TBA'],
    ['active', 'In progress'],
    ['fallout', 'With fallout'],
    ['done', 'Completed']
];


function ensureTimelineView() {
    initTimelineControls();
    initTimelineHover();
    if (timeline.loaded) { renderTimeline(); return; }
    if (timeline.loading) return;
    timeline.loading = true;
    loadTimeline();
}

async function loadTimeline() {
    try {
        const d = await api('/upgrades?limit=200');
        timeline.upgrades = d.upgrades || [];
        timeline.loaded = true;
        timeline.error = null;
    } catch (err) {
        // A 404 means an older chains-api deployment — the Pages dashboard
        // can front-run the API rollout — so say that instead of a generic
        // failure. Anything else is retried on the next visit to the tab.
        timeline.error = /→ 404$/.test(err?.message || '') ? 'old-api' : 'down';
    } finally {
        timeline.loading = false;
    }
    renderTimeline();
}

function timelineActivationMs(u) {
    const t = Date.parse(u.activationAt || '');
    return Number.isNaN(t) ? null : t;
}

function timelineMatchesSearch(u, q) {
    if ((u.title || '').toLowerCase().includes(q) || (u.provider || '').toLowerCase().includes(q)) return true;
    if ((u.networkNames || []).some(n => n.toLowerCase().includes(q))) return true;
    if ((u.software || []).some(s => `${s.client || ''} ${s.version || ''}`.toLowerCase().includes(q))) return true;
    return (u.chainIds || []).some(id => String(id).includes(q) || state.byId.get(id)?.name?.toLowerCase().includes(q));
}

// Which stream tab an upgrade belongs to. Pending is decided by the clock, not
// by status: providers leave a window labelled "scheduled" long after it ran.
function timelineStreamOf(u, now) {
    const ms = timelineActivationMs(u);
    // Undated but not finished: announced, day unknown. Calling this 'done' would file a
    // pending fork under history purely because nobody has named the date yet.
    if (ms == null) return u.status === 'maintenance_completed' ? 'done' : 'undated';
    if (ms > now) return 'upcoming';
    if (u.status === 'maintenance_in_progress') return 'active';
    return 'done';
}

function timelineInStream(u, stream, now) {
    if (stream === 'all') return true;
    if (stream === 'fallout') return (u.followedByIncidents || []).length > 0;
    return timelineStreamOf(u, now) === stream;
}

// Undated windows cannot be placed on a time axis at all. They are excluded from the chart
// and counted next to it, never silently dropped.
function timelineUndated(items) { return items.filter((u) => !isDated(u)); }

// The x-domain: `rangeDays` back from now, and forward to the last pending
// window (bounded by the same span, so a window three weeks out never squashes
// the last 24 hours into a pixel). 'All' fits every window in the payload.
function timelineDomain(items, now) {
    const times = items.filter(isDated).map(timelineActivationMs);
    if (timeline.rangeDays === 0) {
        const lo = times.length ? Math.min(...times, now) : now - 7 * 864e5;
        const hi = times.length ? Math.max(...times, now) : now + 864e5;
        const pad = Math.max((hi - lo) * 0.02, 36e5);
        return [lo - pad, hi + pad];
    }
    const span = timeline.rangeDays * 864e5;
    const lastPending = Math.max(now, ...times.filter(t => t > now));
    return [now - span, Math.min(lastPending + span * 0.05, now + span)];
}

function renderTimeline() {
    const rowsWrap = byId('timelineRows');
    if (!rowsWrap) return;
    const meta = byId('timelineMeta');

    if (timeline.error) {
        const msg = timeline.error === 'old-api'
            ? 'Timeline requires a newer chains-api — the API this dashboard points at doesn’t serve /upgrades yet.'
            : 'Upgrade timeline unavailable — the /upgrades feed didn’t answer. Revisit the tab to retry.';
        rowsWrap.textContent = '';
        rowsWrap.appendChild(el('div', { class: 'feed-empty', text: msg }));
        timeline.hover = null;
        hideTimelineHover();
        byId('timelineChartWrap')?.setAttribute('hidden', '');
        if (meta) meta.textContent = '';
        return;
    }
    if (!timeline.loaded) {
        rowsWrap.textContent = '';
        rowsWrap.appendChild(el('div', { class: 'feed-empty', text: 'Loading upgrade timeline…' }));
        return;
    }
    byId('timelineChartWrap')?.removeAttribute('hidden');

    const now = Date.now();
    const searched = searchQuery ? timeline.upgrades.filter(u => timelineMatchesSearch(u, searchQuery)) : timeline.upgrades;
    const [lo, hi] = timelineDomain(searched, now);
    // The chart shows everything the search matched inside the window; the tabs
    // then slice that set, so tab counts always describe what the chart draws.
    const inRange = searched.filter(u => { const t = timelineActivationMs(u); return t != null && t >= lo && t <= hi; });
    // Undated windows have no position on a time axis, so they are never plotted — but they
    // ARE listed and counted, because "announced, day unknown" is information a reader needs
    // rather than a row to hide.
    const undated = timelineUndated(searched);
    const tabbable = [...inRange, ...undated];
    const items = tabbable.filter(u => timelineInStream(u, timeline.stream, now));

    renderTimelineTabs(tabbable, now);
    renderTimelineChart(inRange, items, [lo, hi], now, undated.length);
    renderTimelineRows(items, now);

    if (meta) meta.textContent = `${timeline.upgrades.length} tracked`;
    // Only a DATED window can be counted down to. An undated announcement must never
    // produce a "next window in ..." headline.
    const nextUp = searched.filter(isDated).map(timelineActivationMs).filter(t => t > now).sort((a, b) => a - b)[0];
    const notice = byId('timelineNextNotice');
    if (notice) {
        notice.textContent = '';
        if (nextUp != null) {
            const u = searched.find(x => timelineActivationMs(x) === nextUp);
            notice.appendChild(el('span', { class: 'tlx-next-label', text: 'Next window' }));
            notice.appendChild(el('span', { class: 'tlx-next-count mono tl-countdown', 'data-at': String(nextUp), text: countdownText(nextUp - now) }));
            notice.appendChild(el('span', { class: 'tlx-next-title', text: `${timelineNetworkLabel(u)} · ${u.title}` }));
            notice.hidden = false;
        } else {
            notice.hidden = true;
        }
    }

    if (searched.some(u => (timelineActivationMs(u) ?? 0) > now)) startTimelineTicker(); else stopTimelineTicker();
}

function renderTimelineTabs(inRange, now) {
    const bar = byId('timelineTabs');
    if (!bar) return;
    bar.textContent = '';
    for (const [key, label] of TL_STREAMS) {
        const n = inRange.filter(u => timelineInStream(u, key, now)).length;
        bar.appendChild(el('button', {
            class: `tlx-tab${timeline.stream === key ? ' active' : ''}`,
            onclick: () => { timeline.stream = key; renderTimeline(); }
        }, [
            el('span', { class: 'tlx-tab-label', text: label }),
            el('span', { class: 'tlx-tab-count', text: String(n) })
        ]));
    }
}

// ─── The chart ───
// Area = number of windows activating per bucket, drawn as a stepped density
// curve. Past and future are two separate paths so the future can be hatched.
// Above it ride pins for the windows that matter most (fallout, then urgency),
// each dropping a leader line onto its exact position on the axis.
const TL_CHART_W = 1000;   // viewBox units; the SVG scales to its container
const TL_CHART_H = 150;
const TL_BUCKETS = 96;

function renderTimelineChart(inRange, selected, [lo, hi], now, undatedCount = 0) {
    const host = byId('timelineChart');
    if (!host) return;
    host.textContent = '';
    // Say what the chart cannot show. A silently short axis reads as "nothing else exists".
    const omitted = byId('timelineOmitted');
    if (omitted) {
        omitted.textContent = undatedCount
            ? `${undatedCount} window${undatedCount === 1 ? '' : 's'} not plotted — no date announced`
            : '';
        omitted.hidden = !undatedCount;
    }
    const span = Math.max(hi - lo, 1);
    const x = (t) => ((t - lo) / span) * TL_CHART_W;

    const counts = new Array(TL_BUCKETS).fill(0);
    for (const u of inRange) {
        const t = timelineActivationMs(u);
        if (t == null) continue;
        counts[Math.min(TL_BUCKETS - 1, Math.max(0, Math.floor(((t - lo) / span) * TL_BUCKETS)))] += 1;
    }
    const peak = Math.max(1, ...counts);
    const bw = TL_CHART_W / TL_BUCKETS;
    const y = (n) => TL_CHART_H - (n / peak) * (TL_CHART_H - 14);

    // Stepped outline across all buckets; the fill closes it to the baseline.
    const pts = [];
    counts.forEach((n, i) => { pts.push([i * bw, y(n)], [(i + 1) * bw, y(n)]); });
    const line = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
    const nowX = Math.max(0, Math.min(TL_CHART_W, x(now)));

    const defs = Viz.svgEl('defs', {}, [
        Viz.svgEl('linearGradient', { id: 'tlxFill', x1: '0', y1: '0', x2: '0', y2: '1' }, [
            Viz.svgEl('stop', { offset: '0%', 'stop-color': 'var(--tlx-accent)', 'stop-opacity': '0.45' }),
            Viz.svgEl('stop', { offset: '100%', 'stop-color': 'var(--tlx-accent)', 'stop-opacity': '0.02' })
        ]),
        Viz.svgEl('pattern', { id: 'tlxHatch', width: '6', height: '6', patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, [
            Viz.svgEl('rect', { width: '6', height: '6', fill: 'var(--tlx-accent)', 'fill-opacity': '0.06' }),
            Viz.svgEl('line', { x1: '0', y1: '0', x2: '0', y2: '6', stroke: 'var(--tlx-accent)', 'stroke-opacity': '0.35', 'stroke-width': '1.5' })
        ]),
        // Past and future share one outline; each clip reveals its own half.
        Viz.svgEl('clipPath', { id: 'tlxPast' }, [Viz.svgEl('rect', { x: '0', y: '0', width: String(nowX), height: String(TL_CHART_H) })]),
        Viz.svgEl('clipPath', { id: 'tlxFuture' }, [Viz.svgEl('rect', { x: String(nowX), y: '0', width: String(TL_CHART_W - nowX), height: String(TL_CHART_H) })])
    ]);

    const area = `${line} L${TL_CHART_W},${TL_CHART_H} L0,${TL_CHART_H} Z`;
    const svg = Viz.svgEl('svg', {
        viewBox: `0 0 ${TL_CHART_W} ${TL_CHART_H}`, preserveAspectRatio: 'none',
        class: 'tlx-svg', role: 'img',
        'aria-label': `Upgrade window density, ${new Date(lo).toLocaleDateString()} to ${new Date(hi).toLocaleDateString()}`
    }, [
        defs,
        Viz.svgEl('path', { d: area, fill: 'url(#tlxFill)', 'clip-path': 'url(#tlxPast)' }),
        Viz.svgEl('path', { d: area, fill: 'url(#tlxHatch)', 'clip-path': 'url(#tlxFuture)' }),
        Viz.svgEl('path', { d: line, fill: 'none', stroke: 'var(--tlx-accent)', 'stroke-width': '1.5', 'vector-effect': 'non-scaling-stroke' }),
        Viz.svgEl('line', { x1: String(nowX), y1: '0', x2: String(nowX), y2: String(TL_CHART_H), class: 'tlx-nowline', 'vector-effect': 'non-scaling-stroke' })
    ]);
    host.appendChild(svg);

    renderTimelinePins(inRange, selected, x, now);
    renderTimelineHeat(inRange, x);
    renderTimelineAxis(lo, hi, nowX);

    // Hand the hover layer the same domain and bucketing the chart just drew,
    // so the tooltip always describes the exact bar under the cursor.
    timeline.hover = { lo, hi, buckets: bucketize(inRange, lo, hi) };
}

// inRange split into the same TL_BUCKETS the area chart uses. The tooltip reads
// from this rather than re-deriving, so a bar of height 3 always lists 3 rows.
function bucketize(items, lo, hi) {
    const span = Math.max(hi - lo, 1);
    const buckets = Array.from({ length: TL_BUCKETS }, () => []);
    for (const u of items) {
        const t = timelineActivationMs(u);
        if (t == null) continue;
        buckets[Math.min(TL_BUCKETS - 1, Math.max(0, Math.floor(((t - lo) / span) * TL_BUCKETS)))].push(u);
    }
    for (const b of buckets) b.sort((a, c) => (timelineActivationMs(a) ?? 0) - (timelineActivationMs(c) ?? 0));
    return buckets;
}

// Pins: the windows a reader should notice first — anything with fallout, then
// the most urgent, then the soonest. Capped so they never collide into mush.
function renderTimelinePins(inRange, selected, x, now) {
    const host = byId('timelinePins');
    if (!host) return;
    host.textContent = '';
    const weight = (u) => (u.followedByIncidents?.length ? 100 : 0)
        + (/urgent|critical|mandatory/i.test(u.urgency || '') ? 40 : 0)
        + ((timelineActivationMs(u) ?? 0) > now ? 20 : 0);
    const picked = [...inRange].sort((a, b) => weight(b) - weight(a) || (timelineActivationMs(b) ?? 0) - (timelineActivationMs(a) ?? 0))
        .filter(u => weight(u) > 0).slice(0, 8)
        .sort((a, b) => (timelineActivationMs(a) ?? 0) - (timelineActivationMs(b) ?? 0));

    const selectedSet = new Set(selected);
    let lastPct = -99;
    for (const u of picked) {
        const t = timelineActivationMs(u);
        if (t == null) continue;
        const pct = (x(t) / TL_CHART_W) * 100;
        if (pct - lastPct < 7) continue;   // keep badges legible
        lastPct = pct;
        const fallout = u.followedByIncidents?.length || 0;
        const pin = el('div', {
            class: `tlx-pin${selectedSet.has(u) ? '' : ' dim'}`,
            style: { left: `${pct.toFixed(2)}%` },
            title: `${u.title}\n${new Date(t).toLocaleString()}`
        }, [
            el('span', { class: `tlx-pin-badge ${urgencyClass(u.urgency)}`, text: fallout ? `↯${fallout}` : (timelineNetworkLabel(u) || '•').slice(0, 3) }),
            el('span', { class: 'tlx-pin-stem' })
        ]);
        host.appendChild(pin);
    }
}

// The thin strip under the chart: one blob per window, coloured by urgency —
// AppControl's temperature ribbon, carrying severity instead of heat.
function renderTimelineHeat(inRange, x) {
    const host = byId('timelineHeat');
    if (!host) return;
    host.textContent = '';
    for (const u of inRange) {
        const t = timelineActivationMs(u);
        if (t == null) continue;
        host.appendChild(el('span', {
            class: `tlx-blob ${urgencyClass(u.urgency)}${u.followedByIncidents?.length ? ' has-fallout' : ''}`,
            style: { left: `${((x(t) / TL_CHART_W) * 100).toFixed(2)}%` },
            title: u.title
        }));
    }
}

function renderTimelineAxis(lo, hi, nowX) {
    const host = byId('timelineAxis');
    if (!host) return;
    host.textContent = '';
    const span = hi - lo;
    const withinDay = span <= 36 * 36e5;
    const fmt = (t) => new Date(t).toLocaleString(undefined,
        withinDay ? { hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric' });
    // "now" always wins: a date tick sitting on top of it rendered as "Junow".
    const nowPct = (nowX / TL_CHART_W) * 100;
    for (let i = 0; i <= 6; i += 1) {
        const pct = (i / 6) * 100;
        if (Math.abs(pct - nowPct) < 5) continue;
        host.appendChild(el('span', {
            // The last tick sits at 100% and its centring transform pushed half
            // the label outside the clipped container ("Aug 3" read as "Au").
            class: `tlx-tick${i === 6 ? ' tlx-tick-end' : ''}`,
            style: { left: `${pct.toFixed(2)}%` }, text: fmt(lo + (span * i) / 6)
        }));
    }
    host.appendChild(el('span', { class: 'tlx-tick tlx-tick-now', style: { left: `${nowPct.toFixed(2)}%` }, text: 'now' }));
}

// ─── Hover crosshair (Grafana-style) ───
// Pointing anywhere across the chart reads out that moment: a vertical
// crosshair, the timestamp under the cursor, and the windows in the bar being
// pointed at. Without it the density curve says "something happened here" and
// gives no way to ask what.
const TL_TOOLTIP_ROWS = 6;

function initTimelineHover() {
    const wrap = byId('timelineChartWrap');
    if (!wrap || wrap.dataset.hoverBound) return;
    wrap.dataset.hoverBound = '1';
    // Pointer events rather than mouse events, so a stylus or touch drag reads
    // the chart too. Touch also fires pointerdown -> move, which is the natural
    // "scrub" gesture on a phone.
    wrap.addEventListener('pointermove', onTimelineHover);
    wrap.addEventListener('pointerdown', onTimelineHover);
    wrap.addEventListener('pointerleave', hideTimelineHover);
}

function onTimelineHover(e) {
    const wrap = byId('timelineChartWrap');
    const cross = byId('timelineCrosshair');
    const tip = byId('timelineTooltip');
    if (!wrap || !cross || !tip || !timeline.hover) return;

    const rect = wrap.getBoundingClientRect();
    if (rect.width <= 0) return;
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const { lo, hi, buckets } = timeline.hover;
    const at = lo + frac * (hi - lo);
    const idx = Math.min(TL_BUCKETS - 1, Math.floor(frac * TL_BUCKETS));

    cross.style.left = `${(frac * 100).toFixed(3)}%`;
    cross.hidden = false;

    renderTimelineTooltip(tip, buckets[idx] ?? [], at, hi - lo);
    // Follow the cursor, flipping before the tooltip would leave the panel.
    const width = tip.offsetWidth || 280;
    const raw = frac * rect.width + 14;
    tip.style.left = `${Math.max(6, Math.min(raw, rect.width - width - 6)).toFixed(0)}px`;
    tip.hidden = false;
}

function hideTimelineHover() {
    const cross = byId('timelineCrosshair');
    const tip = byId('timelineTooltip');
    if (cross) cross.hidden = true;
    if (tip) tip.hidden = true;
}

function renderTimelineTooltip(tip, items, at, spanMs) {
    tip.textContent = '';
    // Resolution follows the zoom: a 1-day view wants minutes, a month wants
    // the date. Same rule as the axis, so the two never disagree.
    const stamp = new Date(at).toLocaleString(undefined, spanMs <= 36 * 36e5
        ? { weekday: 'short', hour: '2-digit', minute: '2-digit' }
        : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

    tip.appendChild(el('div', { class: 'tlx-tip-head' }, [
        el('span', { class: 'tlx-tip-time mono', text: stamp }),
        el('span', { class: 'tlx-tip-count', text: items.length ? `${items.length} window${items.length === 1 ? '' : 's'}` : 'nothing scheduled' })
    ]));

    const now = Date.now();
    for (const u of items.slice(0, TL_TOOLTIP_ROWS)) {
        const ms = timelineActivationMs(u);
        const pending = ms != null && ms > now;
        tip.appendChild(el('div', { class: 'tlx-tip-row' }, [
            el('span', { class: `tlx-tip-dot ${urgencyClass(u.urgency)}` }),
            el('span', {
                class: `tlx-tip-when mono${pending ? ' pending' : ''}`,
                text: ms != null ? new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '—'
            }),
            el('span', { class: 'tlx-tip-title', text: u.title }),
            el('span', { class: 'tlx-tip-meta', text: [timelineNetworkLabel(u), u.provider].filter(Boolean).join(' · ') }),
            (u.software || []).length
                ? el('span', { class: 'tlx-tip-sw mono', text: (u.software || []).map(s => [s.client, s.version].filter(Boolean).join(' ')).join(', ') })
                : null,
            u.followedByIncidents?.length
                ? el('span', { class: 'tlx-tip-fallout', text: `↯ ${u.followedByIncidents.length} incident${u.followedByIncidents.length === 1 ? '' : 's'} followed` })
                : null
        ]));
    }
    if (items.length > TL_TOOLTIP_ROWS) {
        tip.appendChild(el('div', { class: 'tlx-tip-more', text: `+${items.length - TL_TOOLTIP_ROWS} more in this interval` }));
    }
}

// ─── Rows ───
const TL_SORTS = [
    ['time', 'Time'],
    ['urgency', 'Urgency'],
    ['fallout', 'Fallout'],
    ['provider', 'Provider']
];

const TL_URGENCY_RANK = { mandatory: 3, critical: 3, urgent: 2, standard: 1 };

function renderTimelineRows(items, now) {
    const wrap = byId('timelineRows');
    if (!wrap) return;
    wrap.textContent = '';
    const count = byId('timelineCount');
    // Says what it is SCOPED to: the header pill counts everything tracked, this counts what
    // survived the range and the search, and two bare "N windows" a few pixels apart read as a
    // contradiction rather than as two different questions.
    if (count) count.textContent = `${items.length} in range${searchQuery ? ` · “${searchQuery}”` : ''}`;

    if (!items.length) {
        wrap.appendChild(el('div', { class: 'feed-empty', text: searchQuery ? 'Nothing matches.' : 'No windows in this range.' }));
        return;
    }

    const sorted = [...items].sort((a, b) => {
        if (timeline.sort === 'urgency') {
            const d = (TL_URGENCY_RANK[(b.urgency || '').toLowerCase()] || 0) - (TL_URGENCY_RANK[(a.urgency || '').toLowerCase()] || 0);
            if (d) return d;
        } else if (timeline.sort === 'fallout') {
            const d = (b.followedByIncidents?.length || 0) - (a.followedByIncidents?.length || 0);
            if (d) return d;
        } else if (timeline.sort === 'provider') {
            const d = (a.provider || '').localeCompare(b.provider || '');
            if (d) return d;
        }
        // Default and tiebreak: pending soonest-first, then history newest-first.
        const ta = timelineActivationMs(a) ?? 0;
        const tb = timelineActivationMs(b) ?? 0;
        const aP = ta > now, bP = tb > now;
        if (aP !== bP) return aP ? -1 : 1;
        return aP ? ta - tb : tb - ta;
    });

    let lastBucket = null;
    for (const u of sorted) {
        // Day separators only make sense while the list is in time order.
        if (timeline.sort === 'time') {
            // Pending windows sort ahead of history, so "Today" occurs twice —
            // once for what is still to come and once for what already ran.
            // Qualify the pending one or the two runs read as a rendering bug.
            const actMs = timelineActivationMs(u);
            const day = timelineDayBucket(actMs, now);
            const bucket = actMs != null && actMs > now ? `${day} · scheduled` : day;
            if (bucket !== lastBucket) {
                lastBucket = bucket;
                wrap.appendChild(el('div', { class: 'tlx-daybreak', text: bucket }));
            }
        }
        wrap.appendChild(timelineRow(u, now));
    }
}

function timelineDayBucket(ms, now) {
    if (ms == null) return 'Date not announced';
    const d = new Date(ms);
    const today = new Date(now);
    const days = Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())) / 864e5);
    if (days === 0) return 'Today';
    if (days === 1) return 'Tomorrow';
    if (days === -1) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function timelineNetworkLabel(u) {
    const names = u.networkNames?.length ? u.networkNames
        : (u.chainIds || []).map(id => state.byId.get(id)?.name).filter(Boolean);
    return names[0] || u.provider || 'Unknown';
}

// "in 2d 4h" / "in 35m" — the live part of a pending row.
function countdownText(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return 'now';
    const m = Math.ceil(ms / 60000);
    if (m < 60) return `in ${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `in ${h}h ${m % 60}m`;
    return `in ${Math.floor(h / 24)}d ${h % 24}h`;
}

// One shared minute tick updates every visible countdown in place; a window
// crossing into the past re-renders so it re-buckets. Guarded so re-renders
// never stack a second interval; cleared on view switch.
function startTimelineTicker() {
    if (timeline.ticker) return;
    timeline.ticker = setInterval(() => {
        if (activeView !== 'timeline') return;
        let expired = false;
        document.querySelectorAll('#view-timeline .tl-countdown').forEach(n => {
            const left = Number(n.dataset.at) - Date.now();
            if (left <= 0) expired = true;
            n.textContent = countdownText(left);
        });
        if (expired) renderTimeline();
    }, 60000);
}
function stopTimelineTicker() { if (timeline.ticker) { clearInterval(timeline.ticker); timeline.ticker = null; } }

// Sanitized urgency class token (same guard as the severity pill) — the raw
// value still shows as the pill's text. Shared by rows, pins and blobs.
function urgencyClass(urgency) {
    return `urg-${String(urgency || 'standard').toLowerCase().replace(/[^a-z]/g, '')}`;
}
function urgencyPill(urgency) {
    return el('span', { class: `pill ${urgencyClass(urgency)}`, text: urgency || 'standard' });
}

// Fallout: incidents that started on the same network within the follow
// window after activation — the "what did this upgrade cause?" rows.
function timelineFalloutRows(u) {
    // durationEvidence distinguishes "we watched it resolve" from "the page mentioned it once
    // and never said when it ended" — a reader comparing incidents needs that, not a number
    // that silently means different things.
    const durationOf = (inc) => {
        if (inc.durationEvidence === 'observed' && inc.resolvedAt && inc.startedAt) {
            const ms = Date.parse(inc.resolvedAt) - Date.parse(inc.startedAt);
            return ms > 0 ? `lasted ${fmtDuration(ms)}` : 'resolved';
        }
        if (inc.durationEvidence === 'ongoing') return 'still open';
        return 'duration not published';
    };
    return (u.followedByIncidents || []).slice(0, 4).map(inc =>
        el('div', { class: 'tl-fallout' }, [
            el('span', { class: 'tl-fallout-arrow', text: '↳' }),
            inc.url ? el('a', { href: safeUrl(inc.url), target: '_blank', rel: 'noopener', text: inc.title }) : el('span', { text: inc.title }),
            el('span', { class: 'muted', text: `+${inc.hoursAfterActivation}h after activation (suspected)` }),
            el('span', {
                class: inc.durationEvidence === 'ongoing' ? 'tl-fallout-open' : 'muted',
                text: durationOf(inc)
            })
        ]));
}

// Context: governance discussion (forum) and editorial coverage (news) around
// the window. Deduped by URL — the same ACD call is often carried by both
// feeds, and two identical links under one window reads as a bug.
function timelineContextRows(u) {
    const row = (label, item) => el('div', { class: 'tl-context' }, [
        el('span', { class: 'tl-context-kind', text: label }),
        el('a', { href: safeUrl(item.url), target: '_blank', rel: 'noopener', text: item.title }),
        item.publishedAt ? el('span', { class: 'muted', text: relTime(item.publishedAt) }) : null
    ]);
    const seen = new Set();
    const fresh = (list) => (list || []).filter(i => {
        const k = (i.url || i.title || '').toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
    return [
        ...fresh(u.discussion).slice(0, 2).map(d => row('discussion', d)),
        ...fresh(u.coverage).slice(0, 2).map(c => row('coverage', c))
    ];
}

// One row. Time leads (this is a timeline), then network + title, then the
// evidence chips. Detail — fallout, discussion, coverage — is collapsed behind
// a disclosure so a hundred windows stay scannable; rows with fallout open by
// default because that is the finding, not a footnote.
function timelineRow(u, now) {
    const actMs = timelineActivationMs(u);
    const pending = actMs != null && actMs > now;
    const label = timelineNetworkLabel(u);
    const chainId = (u.chainIds || [])[0] ?? null;
    const fallout = u.followedByIncidents?.length || 0;

    // A countdown is a claim about a known instant. With no date announced there is nothing
    // to count down to, so the slot says so instead of rendering a dash that looks like a
    // missing value.
    const ev = evidenceOf(u);
    const when = actMs == null
        ? el('span', { class: 'tlx-when tlx-when-tba', title: ev.title, text: 'date TBA' })
        : pending
            ? el('span', { class: 'tlx-when mono tl-countdown', 'data-at': String(actMs), text: countdownText(actMs - now) })
            : el('span', {
                class: 'tlx-when past',
                text: new Date(actMs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
            });

    const chips = [];
    for (const s of (u.software || []).slice(0, 3)) {
        chips.push(el('span', { class: 'sw-chip mono', text: [s.client, s.version].filter(Boolean).join(' ') }));
    }
    if (u.windowMinutes) chips.push(el('span', { class: 'tlx-chip-dim mono', text: fmtDuration(u.windowMinutes * 60000) }));
    // How well the time is known, on every row — the reader should never have to guess
    // whether "02:36 PM" is a stated window or the moment someone posted a notice.
    chips.push(el('span', { class: `tlx-chip-ev ${ev.cls}`, title: ev.title, text: ev.label }));
    if (fallout) chips.push(el('span', { class: 'tlx-chip-fallout', text: `↯ ${fallout} incident${fallout === 1 ? '' : 's'} after` }));

    const detail = [...timelineFalloutRows(u), ...timelineContextRows(u)];

    const head = el('div', { class: 'tlx-row-head' }, [
        el('span', { class: `tlx-row-dot ${urgencyClass(u.urgency)}` }),
        when,
        el('span', { class: 'tlx-row-main' }, [
            u.url ? el('a', { class: 'tlx-row-title', href: safeUrl(u.url), target: '_blank', rel: 'noopener', text: u.title })
                : el('span', { class: 'tlx-row-title', text: u.title }),
            // The network resolves to a registry chain often enough to be worth a link, and a
            // chip here behaves like the affected-chain chips on incident cards. When it does
            // not resolve it stays plain text rather than becoming a dead control.
            el('span', { class: 'tlx-row-sub muted' }, [
                chainId != null && state.byId.has(chainId)
                    ? el('button', { class: 'chain-chip', type: 'button', text: label, onclick: e => { e.preventDefault(); e.stopPropagation(); openChainDetail(chainId); } })
                    : el('span', { text: label }),
                u.provider ? el('span', { text: ` · ${u.provider}` }) : null
            ])
        ]),
        el('span', { class: 'tlx-row-chips' }, chips),
        urgencyPill(u.urgency),
        feedbackAffordance({ kind: 'upgrade', refId: u.incidentId || u.title })
    ]);

    if (!detail.length) return el('div', { class: `tlx-row${pending ? ' pending' : ''}` }, [head]);

    const body = el('div', { class: 'tlx-row-detail' }, detail);
    const toggle = el('button', {
        class: 'tlx-row-toggle',
        'aria-expanded': fallout ? 'true' : 'false',
        text: fallout ? 'Hide links' : `${detail.length} linked`,
        onclick: (e) => {
            const open = body.hidden;
            body.hidden = !open;
            e.currentTarget.setAttribute('aria-expanded', String(open));
            e.currentTarget.textContent = open ? 'Hide links' : `${detail.length} linked`;
        }
    });
    body.hidden = !fallout;
    head.insertBefore(toggle, head.lastChild);
    return el('div', { class: `tlx-row${pending ? ' pending' : ''}${fallout ? ' has-fallout' : ''}` }, [head, body]);
}

// Range + sort controls. Built once; re-render only repaints their active state.
function initTimelineControls() {
    const rangeBar = byId('timelineRange');
    if (rangeBar && !rangeBar.childElementCount) {
        for (const [label, days] of TL_RANGES) {
            rangeBar.appendChild(el('button', {
                class: `tlx-range-btn${timeline.rangeDays === days ? ' active' : ''}`,
                'data-days': String(days), text: label,
                onclick: () => {
                    timeline.rangeDays = days;
                    rangeBar.querySelectorAll('.tlx-range-btn').forEach(b => b.classList.toggle('active', Number(b.dataset.days) === days));
                    renderTimeline();
                }
            }));
        }
    }
    const sortSel = byId('timelineSort');
    if (sortSel && !sortSel.childElementCount) {
        for (const [key, label] of TL_SORTS) sortSel.appendChild(el('option', { value: key, text: label }));
        sortSel.value = timeline.sort;
        sortSel.addEventListener('change', () => { timeline.sort = sortSel.value; renderTimeline(); });
    }
}

// ─── Wrong-info reporting ────────────────────────────────────────────────
// A feed can be confidently wrong — the wrong chain, a stale version, a misread time
// — and only a human reader can tell which. Every timeline and incident card
// gets a small flag that unfolds an inline report form posting to /feedback.
const FEEDBACK_REASONS = [
    ['wrong_chain', 'Wrong chain/network'],
    ['wrong_version', 'Wrong version'],
    ['wrong_time', 'Wrong time'],
    ['not_related', 'Not related'],
    ['misclassified', 'Misclassified'],
    ['outdated', 'Outdated'],
    ['other', 'Other']
];

function feedbackAffordance({ kind, refId }) {
    const wrap = el('div', { class: 'report-wrap' });
    // Incident cards are anchors: swallow clicks anywhere in the affordance
    // so opening the form / picking a reason never navigates the card's link
    // (preventDefault stops the anchor; the controls' own listeners and
    // mousedown-driven behaviour — select opening, input focus — still work).
    wrap.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); });

    const btn = el('button', { class: 'report-btn', title: 'Report wrong info', 'aria-label': 'Report wrong info', text: '⚑ report' });
    const select = el('select', { class: 'report-reason' },
        FEEDBACK_REASONS.map(([value, label]) => el('option', { value, text: label })));
    const comment = el('input', { class: 'report-comment', type: 'text', maxlength: '500', placeholder: 'What’s wrong? (optional)' });
    const send = el('button', { class: 'report-send', text: 'Send' });
    const note = el('span', { class: 'report-note hidden' });
    const form = el('div', { class: 'report-form hidden' }, [select, comment, send, note]);

    btn.addEventListener('click', () => form.classList.toggle('hidden'));
    send.addEventListener('click', async () => {
        send.disabled = true;
        note.classList.add('hidden');
        const body = { kind, reason: select.value, page: activeView };
        if (refId) body.refId = String(refId).slice(0, 200);
        const text = comment.value.trim();
        if (text) body.comment = text.slice(0, 500);
        let res = null;
        try { res = await apiPost('/feedback', body, { timeoutMs: 15000 }); } catch { /* network error → note below */ }
        if (res?.ok) {
            form.textContent = '';
            form.appendChild(el('span', { class: 'report-thanks', text: 'Thanks — recorded.' }));
            btn.disabled = true;
            return;
        }
        note.textContent = res?.status === 429 ? 'Too many reports — try again in a minute.'
            : res ? (res.data?.error || 'Couldn’t send — try again.')
            : 'Couldn’t send — network error.';
        note.classList.remove('hidden');
        send.disabled = false;
    });

    wrap.appendChild(btn);
    wrap.appendChild(form);
    return wrap;
}
