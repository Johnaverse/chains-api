// ═════════════════════════════════════════════════════════════════════════
// Chain profile page — <base>chains/<id>
//
// Everything the API knows about one network on one page: identity and links, its
// relationship graph, RPC endpoints as probed, the clients its nodes run and the client
// software that ships for it, hardforks, timeline events, incidents, L2 and activity
// figures, research, the validation findings that name it, and the raw records.
//
// Loaded after app.js and built from its helpers (el, api, detailRow, statTile, …). Each
// section fetches on its own and fills in when it answers, so one slow or failed source
// leaves a section hidden or saying so — never a blank page.
// ═════════════════════════════════════════════════════════════════════════
const profile = {
    // path → { at, promise }: going back and forth between chains, or the second render
    // that follows the bulk load, reads from here instead of the network.
    cache: new Map(),
    renderToken: 0,
    // Relationship graph: second hop shown, relation roles hidden by the legend.
    depth: 2,
    hiddenRoles: new Set(),
    graphResize: null,
    // The profile's block-head poller (app.js startHeadPoller), apart from the drawer's: opening
    // a client in the drawer over the profile stops the drawer's, which must not freeze this one.
    head: { timer: null },
    // The chain the page was last built for; null while a deep link waits for the bulk data.
    renderedChain: null,
    // The bulk data it was built from (bulkKey), and whether every bulk source has failed.
    renderedBulk: null,
    bulkFailed: false,
    // What a newer bulk load refreshes in place (refreshProfileBulk).
    bulk: null,
    redrawGraph: null,
    pageTitle: null
};
const PROFILE_CACHE_MS = 60000;
const PROFILE_CACHE_MAX = 300;
const PROFILE_LIST_ROWS = 8;
// Second-hop nodes drawn per direct neighbour; the rest are a "+N" on that neighbour's slot
// (Sepolia alone carries ~100 L2 testnets, which would take the whole ring).
const GRAPH_KIDS_SHOWN = 10;

function profileFetch(path) {
    const hit = profile.cache.get(path);
    if (hit && Date.now() - hit.at < PROFILE_CACHE_MS) return hit.promise;
    if (profile.cache.size >= PROFILE_CACHE_MAX) profile.cache.clear();
    const promise = api(path).catch(err => { profile.cache.delete(path); throw err; });
    profile.cache.set(path, { at: Date.now(), promise });
    return promise;
}

// A link to a chain's profile: a real href (new tab, copy link) that navigates in place on a
// plain click.
function profileLink(chainId, text, cls = 'chip-link') {
    return el('a', {
        class: cls, href: profileHref(chainId), text,
        onclick: e => {
            if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            openChainProfile(chainId);
        }
    });
}
function chainProfileLink(chainId) {
    return profileLink(chainId, state.byId.get(chainId)?.name || `Chain ${chainId}`);
}

function openChainProfile(chainId, opts = {}) {
    const same = activeView === 'chain' && profileChainId === chainId;
    // Already showing this chain (history, or applyBulk re-applying the URL): keep the page as
    // it is — expanded sections, an open drawer — unless it was built before the bulk data.
    if (same && opts.fromUrl && profile.renderedChain === chainId) {
        // A newer bulk load (the network answer after the cached one): refresh what it feeds —
        // value secured, scaling figures, the graph's types and sizes — and keep the rest.
        if (profile.renderedBulk !== bulkKey()) refreshProfileBulk();
        return;
    }
    if (openChainId != null) closeDrawer({ fromUrl: true });
    profileChainId = chainId;
    switchView('chain', { fromUrl: true });
    if (!opts.fromUrl) updateUrl({ push: true });
    // A deep link opens before the bulk data (names, types, relations, L2BEAT) has loaded. Build
    // once it has — applyBulk re-applies the URL — or once it has failed (renderPendingProfile).
    if (!state.chains.length && !profile.bulkFailed) {
        profile.renderedChain = null;
        const root = byId('chainProfile');
        if (root && !root.querySelector('.pf-loading')) {
            clear(root);
            root.appendChild(el('p', { class: 'dim pf-loading', text: 'Loading network…' }));
        }
        return;
    }
    renderChainProfile(chainId, { keepScroll: same });
}
// The bulk load failed: build profiles from the per-chain endpoints alone, this one and the next
// ones opened, until a bulk load succeeds.
function renderPendingProfile() {
    profile.bulkFailed = true;
    if (activeView === 'chain' && profileChainId != null && profile.renderedChain == null) renderChainProfile(profileChainId);
}
function bulkKey() { return `${state.lastUpdated ?? ''}|${state.l2beatMeta?.fetchedAt ?? ''}|${state.chains.length}`; }
function refreshProfileBulk() {
    const b = profile.bulk;
    if (!b || profileChainId !== b.chainId) return;
    profile.renderedBulk = bulkKey();
    const l2b = state.l2beat.get(b.chainId);
    if (l2b?.tvs != null) b.kpi.value = l2bKpi(l2b); else delete b.kpi.value;
    profileFetch(`/chains/${b.chainId}`).catch(() => ({})).then(d => {
        if (profileChainId !== b.chainId) return;
        const c = { ...(state.byId.get(b.chainId) || { chainId: b.chainId }), ...(d || {}) };
        renderProfileHero(b.hero, c);
        b.activityCard.querySelector('.pf-body')?.remove();
        b.activityCard.classList.add('hidden');
        renderProfileActivity(b.activityCard, c, l2b, b.kpi);
        b.drawKpis();
    });
    profile.redrawGraph?.();
}
function l2bKpi(l2b) {
    return { label: 'Value secured', value: fmtUsd(l2b.tvs), sub: [l2b.stage, 'L2BEAT'].filter(Boolean).join(' · '), hint: 'Total value secured, from L2BEAT' };
}

function stopProfileHead() { stopHeadPoller(profile.head); }

function leaveChainProfile() {
    stopProfileHead();
    Viz.hideTip();
    profile.graphResize?.disconnect();
    profile.graphResize = null;
    if (profile.pageTitle) { document.title = profile.pageTitle; profile.pageTitle = null; }
}

function profileCard(title, { wide = false, meta = null } = {}) {
    const head = el('div', { class: 'card-head' }, [el('h3', { class: 'card-title', text: title })]);
    if (meta) head.appendChild(el('span', { class: 'pill-meta', text: meta }));
    return el('section', { class: `card pf-card${wide ? ' pf-wide' : ''}`, 'aria-label': title }, [head]);
}
function cardBody(card) { return card.appendChild(el('div', { class: 'pf-body' })); }
function setCardMeta(card, text) {
    const head = card.querySelector('.card-head');
    let meta = head.querySelector('.pill-meta');
    if (!meta) meta = head.appendChild(el('span', { class: 'pill-meta' }));
    meta.textContent = text;
}
function emptyNote(text) { return el('p', { class: 'dim pf-empty', text }); }
// Explorers come as { name, url } or as a bare URL string, depending on the source.
function explorerOf(x) { return typeof x === 'string' ? { url: x, name: null } : (x || {}); }
function extLink(url, text) {
    const href = safeUrl(url);
    return href ? el('a', { href, target: '_blank', rel: 'noopener', text: text || safeHost(url) || url }) : el('span', { text: text || url });
}
// Shows the first rows of a list and a toggle for the rest.
function moreList(items, { shown = PROFILE_LIST_ROWS, cls = 'pf-list' } = {}) {
    const head = items.slice(0, shown);
    const rest = items.slice(shown);
    const wrap = el('div', { class: cls }, head);
    if (!rest.length) return wrap;
    const extra = el('div', { class: `${cls} hidden` }, rest);
    const label = `Show ${rest.length} more`;
    const toggle = el('button', {
        class: 'btn r-more', type: 'button', 'aria-expanded': 'false', text: label,
        onclick: () => {
            const open = extra.classList.toggle('hidden') === false;
            toggle.setAttribute('aria-expanded', String(open));
            toggle.textContent = open ? 'Show less' : label;
        }
    });
    return el('div', {}, [wrap, extra, toggle]);
}

async function renderChainProfile(chainId, { keepScroll = false } = {}) {
    const root = byId('chainProfile');
    if (!root) return;
    const token = ++profile.renderToken;
    // A different chain starts with every relation shown, whatever the last one filtered.
    if (profile.renderedChain !== chainId) { profile.hiddenRoles.clear(); profile.depth = 2; }
    profile.renderedChain = chainId;
    profile.renderedBulk = bulkKey();
    profile.redrawGraph = null;
    if (state.chains.length) profile.bulkFailed = false;
    // The profile's own answers count only while the profile shows this chain, not when the
    // same chain is open in the drawer.
    const live = () => token === profile.renderToken && activeView === 'chain' && profileChainId === chainId;
    stopProfileHead();
    profile.graphResize?.disconnect();
    clear(root);
    if (!keepScroll) byId('view-chain')?.scrollTo(0, 0);

    const known = state.byId.get(chainId);
    const hero = el('div', { class: 'pf-hero' });
    const kpis = el('div', { class: 'stat-row pf-kpis', 'aria-live': 'polite' });
    // Warnings above everything else: what is wrong now, and the next hardfork to prepare for.
    const alerts = el('div', { class: 'pf-alerts', role: 'status', 'aria-live': 'polite' });
    root.append(
        el('nav', { class: 'pf-crumbs', 'aria-label': 'Breadcrumb' }, [
            el('a', {
                href: `${APP_BASE}?view=networks`, text: '← Networks',
                onclick: e => { if (e.button === 0 && !e.metaKey && !e.ctrlKey) { e.preventDefault(); switchView('networks'); } }
            })
        ]),
        hero, alerts, kpis
    );
    renderProfileHero(hero, known || { chainId });

    const graphCard = profileCard('Relationships', { wide: true });
    const identityCard = profileCard('Network detail');
    const incidentCard = profileCard('Incidents');
    const rpcCard = profileCard('RPC endpoints', { wide: true });
    const liveClientCard = profileCard('Clients on probed nodes');
    const softwareCard = profileCard('Client software');
    const forkCard = profileCard('Hardforks', { wide: true });
    const eventCard = profileCard('Upgrades & maintenance');
    const forumCard = profileCard('Recent forum posts');
    const activityCard = profileCard('Scaling & activity', { wide: true });
    const researchCard = profileCard('Research', { wide: true });
    const hardwareCard = profileCard('Node hardware', { wide: true });
    const qualityCard = profileCard('Data quality', { wide: true });
    const rawCard = profileCard('All data', { wide: true, meta: 'raw API records' });
    root.appendChild(el('div', { class: 'pf-grid' }, [
        graphCard, identityCard, incidentCard, rpcCard, liveClientCard, softwareCard,
        forkCard, eventCard, forumCard, activityCard, researchCard, hardwareCard, qualityCard, rawCard
    ]));
    for (const card of [softwareCard, forumCard, activityCard, researchCard, hardwareCard]) card.classList.add('hidden');

    // Headline figures, filled as their sources answer.
    const kpi = {};
    const drawKpis = () => {
        if (!live()) return;
        clear(kpis);
        for (const key of ['rpc', 'relations', 'clients', 'incidents', 'forks', 'value', 'users', 'txcost']) {
            if (kpi[key]) kpis.appendChild(statTile(kpi[key]));
        }
    };
    const relCounts = relationCounts(chainId);
    if (relCounts) kpi.relations = { label: 'Related networks', value: fmtNum(relCounts.total), sub: relCounts.sub };
    profile.alerts = { node: alerts, chainId, nextFork: null, incidentCard };
    profile.incidents = { card: incidentCard, chainId, kpi, drawKpis: () => drawKpis() };
    drawProfileAlerts();
    renderProfileIncidents(incidentCard, chainId, kpi);
    const l2b = state.l2beat.get(chainId);
    if (l2b?.tvs != null) kpi.value = l2bKpi(l2b);
    profile.bulk = { chainId, kpi, drawKpis: () => drawKpis(), activityCard, hero };
    drawKpis();

    const detail = profileFetch(`/chains/${chainId}`).catch(err => (err.status === 404 ? null : {}));
    const settled = (path) => profileFetch(path).then(v => ({ ok: true, v }), err => ({ ok: false, err }));

    detail.then(d => {
        if (!live()) return;
        if (d === null && !known) { renderProfileMissing(root, chainId); return; }
        const c = { ...(known || { chainId }), ...(d || {}) };
        renderProfileHero(hero, c);
        renderProfileIdentity(identityCard, c);
        renderProfileActivity(activityCard, c, l2b, kpi);
        drawKpis();
        // renderResearch shows the card only when there is something it renders (a block holding
        // only node-hardware sizing stays hidden).
        if (c.research) {
            renderResearch(c.research, researchCard);
            const r = c.research;
            const when = r.checkedAt || r.updatedAt;
            setCardMeta(researchCard, [r.coverage && `${r.coverage} coverage`, r.auditStatus && `audit ${r.auditStatus}`, when && `checked ${relTime(when)}`].filter(Boolean).join(' · '));
        }
        renderProfileHardware(hardwareCard, c.research?.hardware);
    });

    settled(`/relations/${chainId}/graph?depth=2`).then(r => {
        if (!live()) return;
        if (!r.ok) { cardBody(graphCard).appendChild(emptyNote('Relationships could not be loaded.')); return; }
        renderRelationGraph(graphCard, chainId, r.v);
        const roles = relationRolesOf(r.v, chainId);
        const direct = [...roles.direct.values()];
        if (direct.length) {
            const by = role => direct.filter(n => n.role === role).length;
            const sub = [['child', 'L2 / L3'], ['testnet', 'testnet'], ['parent', 'settles on'], ['mainnet', 'testnet of']]
                .filter(([role]) => by(role)).map(([role, label]) => `${by(role)} ${label}`).join(' · ');
            kpi.relations = { label: 'Related networks', value: fmtNum(direct.length), sub };
            drawKpis();
        }
    });

    Promise.all([settled(`/rpc-monitor/${chainId}`), settled(`/endpoints/${chainId}`)]).then(([mon, eps]) => {
        if (!live()) return;
        renderProfileRpc(rpcCard, chainId, mon.ok ? mon.v : null, eps.ok ? eps.v : null, kpi);
        renderProfileLiveClients(liveClientCard, mon.ok ? mon.v : null);
        drawKpis();
    });
    settled(`/clients/${chainId}`).then(r => {
        if (!live() || !r.ok) return;
        const n = (r.v.clients || []).length;
        if (n) { kpi.clients = { label: 'Node clients seen', value: fmtNum(n), sub: `${fmtNum(r.v.totalNodes || 0)} probed node${r.v.totalNodes === 1 ? '' : 's'}` }; drawKpis(); }
    });
    loadNetworkClients(chainId, softwareCard);
    settled(`/forks?chainId=${chainId}&limit=200`).then(r => {
        if (!live()) return;
        renderProfileForks(forkCard, r.ok ? r.v : null, kpi);
        drawKpis();
        profile.alerts.nextFork = nextForkOf(r.ok ? r.v.forks : []);
        profile.alerts.forkCard = forkCard;
        drawProfileAlerts();
    });
    // One request per type: /timeline applies its limit before any filtering here, so hardforks
    // must not use up the rows this card shows.
    Promise.all(['software_update', 'maintenance'].map(type => settled(`/timeline?chainId=${chainId}&type=${type}&limit=100`))).then(rs => {
        if (!live()) return;
        const ok = rs.filter(r => r.ok);
        renderProfileEvents(eventCard, ok.length ? { entries: ok.flatMap(r => r.v.entries || []) } : null);
    });
    const forumBox = cardBody(forumCard);
    loadForumNews(chainId, forumBox, forumCard);
    settled(`/validate?chainId=${chainId}`).then(r => {
        if (!live()) return;
        renderProfileQuality(qualityCard, chainId, r.ok ? r.v : null);
    });
    renderProfileRaw(rawCard, chainId);
}

function renderProfileMissing(root, chainId) {
    clear(root);
    root.appendChild(el('div', { class: 'pf-hero' }, [
        el('h2', { class: 'view-title', text: `No network with chain ID ${chainId}` }),
        el('p', { class: 'view-lead', text: 'None of the registries this API reads lists it.' })
    ]));
}

// ── hero ──────────────────────────────────────────────────────────────────
function renderProfileHero(hero, c) {
    clear(hero);
    const name = c.name || `Chain ${c.chainId}`;
    if (!profile.pageTitle) profile.pageTitle = document.title;
    document.title = `${name} — Chains`;
    const badges = el('div', { class: 'd-badges' }, [
        el('span', { class: 'badge', text: `ID ${c.chainId}` }),
        c.tags ? typeTag(netClass(c)) : null,
        c.status ? el('span', { class: `pill pill-${statusOf(c)}`, text: statusOf(c) }) : null,
        ...(c.tags ? classTags(c) : []).map(t => el('span', { class: 'tag', text: t }))
    ]);
    const facts = [
        c.shortName ? `short name ${c.shortName}` : null,
        c.caip2Id || null,
        c.nativeCurrency?.symbol ? `${c.nativeCurrency.name || c.nativeCurrency.symbol} (${c.nativeCurrency.symbol})` : null,
        c.family ? `${c.family} family` : null
    ].filter(Boolean);
    const links = [];
    if (c.infoURL) links.push(extLink(c.infoURL, safeHost(c.infoURL) || 'Website'));
    for (const x of (c.explorers || []).map(explorerOf).filter(x => x.url).slice(0, 3)) links.push(extLink(x.url, x.name || safeHost(x.url)));
    if (c.defillama?.twitter) links.push(extLink(`https://x.com/${c.defillama.twitter}`, `@${c.defillama.twitter}`));
    if (c.forumUrl) links.push(extLink(c.forumUrl, 'Forum'));
    // Native append() writes a null as the text "null", unlike el(): leave the absent ones out.
    hero.append(...[
        el('h2', { class: 'pf-title', text: name }),
        badges,
        facts.length ? el('p', { class: 'pf-facts mono', text: facts.join(' · ') }) : null,
        links.length ? el('div', { class: 'pf-links' }, links) : null
    ].filter(Boolean));
    if (c.statusReason) hero.appendChild(el('p', { class: 'dim pf-facts', text: c.statusReason }));
}

// ── identity ──────────────────────────────────────────────────────────────
function renderProfileIdentity(card, c) {
    const body = cardBody(card);
    const row = (label, value) => { if (value != null && value !== '') body.appendChild(detailRow(label, value)); };
    row('Chain ID', el('span', { class: 'mono', text: String(c.chainId) }));
    if (c.fullName && c.fullName !== c.name) row('Full name', el('span', { text: c.fullName }));
    if (c.aliases?.length) row('Also known as', el('span', { text: c.aliases.join(', ') }));
    if (c.shortName) row('Short name', el('span', { class: 'code', text: c.shortName }));
    if (c.caip2Id) row('CAIP-2', el('span', { class: 'code', text: c.caip2Id }));
    if (c.nativeCurrency) {
        const n = c.nativeCurrency;
        row('Native currency', el('span', { text: `${n.name || n.symbol} (${n.symbol}) · ${n.decimals ?? '?'} decimals` }));
    }
    if (c.slip44 != null) row('SLIP-44', el('span', { class: 'mono', text: String(c.slip44) }));
    if (typeof c.price?.usd === 'number') {
        const sym = c.nativeCurrency?.symbol || 'token';
        row(`${sym} price`, el('span', {
            class: c.price.stale ? 'dim' : null,
            title: `${sym} spot price from CoinGecko, read ${relTime(c.price.updatedAt)}. A property of the asset, not of this chain.`,
            text: `$${c.price.usd.toLocaleString()}${typeof c.price.marketCap === 'number' ? ` · market cap ${fmtUsd(c.price.marketCap)}` : ''}${c.price.stale ? ' · stale' : ''}`
        }));
    }
    const explorers = (c.explorers || []).map(explorerOf).filter(x => x.url);
    if (explorers.length) row('Explorers', explorers.map(x => extLink(x.url, x.name || safeHost(x.url))));
    if (c.infoURL) row('Website', extLink(c.infoURL));
    if (c.forumUrl) row('Forum', extLink(c.forumUrl));
    if (c.defillama?.github?.length) row('GitHub', c.defillama.github.slice(0, 8).map(g => extLink(`https://github.com/${g}`, g)));
    if (c.theGraph?.id || c['theGraph-id']) row('The Graph', el('span', { class: 'code', text: c.theGraph?.id || c['theGraph-id'] }));
    if (c.sources?.length) {
        row('Listed by', el('span', {
            title: 'The registries and datasets this record is merged from',
            text: c.sources.join(', ')
        }));
    }
    if (body.children.length === 0) body.appendChild(emptyNote('No registry detail.'));
}

// ── incidents ─────────────────────────────────────────────────────────────
// Redrawn whenever the incident feed or the status-page list changes (app.js calls in).
function refreshProfileIncidents() {
    const p = profile.incidents;
    if (!p || activeView !== 'chain' || profileChainId !== p.chainId) return;
    p.card.querySelector('.pf-body')?.remove();
    renderProfileIncidents(p.card, p.chainId, p.kpi);
    p.drawKpis();
    drawProfileAlerts();
}

// ── warnings ─────────────────────────────────────────────────────────────
// The soonest fork still to come: dated ones by date, then any with only a height.
function nextForkOf(forks = []) {
    const upcoming = forks.filter(f => f.phase === 'upcoming');
    const at = f => Date.parse(f.activationAt || '');
    return upcoming.filter(f => Number.isFinite(at(f))).sort((a, b) => at(a) - at(b))[0]
        || upcoming.find(f => Number.isFinite(f.activationBlock)) || upcoming[0] || null;
}
const ALERT_INCIDENTS_SHOWN = 3;
function drawProfileAlerts() {
    const a = profile.alerts;
    if (!a || profileChainId !== a.chainId) return;
    clear(a.node);
    const jump = card => e => { e.preventDefault(); card?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    const open = state.openByChain.get(a.chainId) || [];
    for (const it of open.slice(0, ALERT_INCIDENTS_SHOWN)) {
        const sev = severityOf(it);
        const dur = durationInfo(it);
        const serious = sev.key === 'critical' || sev.key === 'major';
        a.node.appendChild(el('div', { class: `pf-alert ${serious ? 'is-critical' : 'is-warn'}` }, [
            el('span', { class: 'pf-alert-kind', text: it.isProvider ? 'RPC provider incident' : 'Open incident' }),
            el('span', { class: 'pf-alert-text' }, [
                it.url ? extLink(it.url, it.openedTitle || it.title) : el('span', { text: it.openedTitle || it.title }),
                el('span', { class: 'dim', text: ` · ${[it.spName, it.status, dur?.text].filter(Boolean).join(' · ')}` })
            ]),
            el('span', { class: `sev sev-${sev.key}` }, [el('span', { class: 'sev-mark' }), sev.label])
        ]));
    }
    if (open.length > ALERT_INCIDENTS_SHOWN) {
        a.node.appendChild(el('a', {
            class: 'pf-alert-more', href: '#', text: `${open.length - ALERT_INCIDENTS_SHOWN} more open incident${open.length - ALERT_INCIDENTS_SHOWN === 1 ? '' : 's'} →`,
            onclick: jump(a.incidentCard)
        }));
    }
    const f = a.nextFork;
    if (f) {
        const ms = Date.parse(f.activationAt || '');
        // A countdown only to a stated time: a date-only activation is that day, not its midnight.
        const dayOnly = f.activationPrecision === 'day' || (f.activationAt && isDateOnlyActivation(f.activationAt));
        const when = Number.isFinite(ms) && !dayOnly ? `${countdownText(ms - Date.now())} · ${forkWhen(f)}` : forkWhen(f);
        const link = (f.events || []).find(e => e.url)?.url;
        // The newest release per repository that names this fork. Reported, not a recommendation:
        // a later release may supersede it.
        const newest = new Map();
        for (const e of (f.events || []).filter(e => e.release?.repo)) {
            const prev = newest.get(e.release.repo);
            if (!prev || (Date.parse(e.publishedAt || '') || 0) > (Date.parse(prev.publishedAt || '') || 0)) newest.set(e.release.repo, e);
        }
        const software = [...newest.values()]
            .sort((a, b) => (Date.parse(b.publishedAt || '') || 0) - (Date.parse(a.publishedAt || '') || 0))
            .slice(0, 3).map(e => `${e.release.repo.split('/').pop()} ${e.release.version}`);
        a.node.appendChild(el('div', { class: 'pf-alert is-warn' }, [
            el('span', { class: 'pf-alert-kind', text: 'Next hardfork' }),
            el('span', { class: 'pf-alert-text' }, [
                link ? extLink(link, f.name || 'Unnamed fork') : el('strong', { text: f.name || 'Unnamed fork' }),
                el('span', { text: ` — ${when}` }),
                software.length ? el('span', { class: 'dim', text: ` · named in ${software.join(', ')}` }) : null
            ]),
            el('a', { class: 'pf-alert-more', href: '#', text: 'All hardforks →', onclick: jump(a.forkCard) })
        ]));
    }
}
function renderProfileIncidents(card, chainId, kpi) {
    const body = cardBody(card);
    const open = state.openByChain.get(chainId) || [];
    const sp = state.statusPagesByChain.get(chainId);
    if (sp) body.appendChild(detailRow('Status page', extLink(sp.url, safeHost(sp.url) || sp.name)));
    else if (!statusPagesReady) body.appendChild(detailRow('Status page', el('span', { class: 'dim', text: 'loading…' })));
    if (!open.length) {
        // Zero is only a finding once the feed has been read.
        if (!incidents.backfilled) {
            body.appendChild(emptyNote('The incident feed has not answered yet.'));
            kpi.incidents = { label: 'Open incidents', value: '—', sub: 'incident feed not read yet' };
            return;
        }
        body.appendChild(emptyNote(sp ? 'No open incidents on its status page or its RPC providers.' : 'No open incidents from the status feeds.'));
        kpi.incidents = { label: 'Open incidents', value: '0', sub: sp ? 'status page watched' : statusPagesReady ? 'no status page known' : 'RPC providers watched', tone: 'good' };
        return;
    }
    kpi.incidents = { label: 'Open incidents', value: fmtNum(open.length), sub: `${open.filter(it => it.isProvider).length} from RPC providers`, tone: 'warn' };
    body.appendChild(moreList(open.map(it => {
        const sev = severityOf(it);
        const dur = durationInfo(it);
        return el('div', { class: 'incident-card is-open' }, [
            el('div', { class: 'incident-main' }, [
                el('div', { class: 'incident-title' }, [
                    it.url ? extLink(it.url, it.openedTitle || it.title) : el('span', { text: it.openedTitle || it.title })
                ]),
                el('div', {
                    class: 'incident-meta',
                    text: [it.isProvider ? `${it.spName} (RPC provider)` : it.spName, it.status, dur?.text].filter(Boolean).join(' · ')
                })
            ]),
            el('div', { class: 'incident-side' }, [
                el('span', { class: `sev sev-${sev.key}` }, [el('span', { class: 'sev-mark' }), sev.label])
            ])
        ]);
    }), { shown: 4 }));
}

// ── relationships ─────────────────────────────────────────────────────────
// A graph edge reads "from <kind> to": 1 parentOf 10 makes 10 a child of 1. ROLE_OF_TO is what
// `to` is to `from`; the inverse is what `from` is to `to`.
const ROLE_OF_TO = { parentOf: 'child', l2Of: 'parent', mainnetOf: 'testnet', testnetOf: 'mainnet' };
const ROLE_INVERSE = { child: 'parent', parent: 'child', testnet: 'mainnet', mainnet: 'testnet' };
const ROLE_ORDER = ['parent', 'mainnet', 'testnet', 'child'];
const ROLE_LABEL = { parent: 'Settles on', mainnet: 'Testnet of', testnet: 'Testnets', child: 'L2s / L3s' };
const ROLE_SHORT = { parent: 'parent', mainnet: 'mainnet', testnet: 'testnet', child: 'L2' };

// Each node's relation to the centre (direct) or to the direct neighbour it hangs off (second hop).
function relationRolesOf(g, center) {
    const direct = new Map();
    const second = new Map();
    const names = new Map((g.nodes || []).map(n => [n.chainId, n]));
    const roleOf = (e, from) => (e.from === from ? ROLE_OF_TO[e.kind] : ROLE_INVERSE[ROLE_OF_TO[e.kind]]);
    for (const e of g.edges || []) {
        if (!ROLE_OF_TO[e.kind]) continue;
        if (e.from === center || e.to === center) {
            const other = e.from === center ? e.to : e.from;
            if (other === center || direct.has(other)) continue;
            direct.set(other, { ...names.get(other), chainId: other, role: roleOf(e, center), source: e.source });
        }
    }
    for (const e of g.edges || []) {
        if (!ROLE_OF_TO[e.kind]) continue;
        for (const [anchor, other] of [[e.from, e.to], [e.to, e.from]]) {
            if (!direct.has(anchor) || other === center || direct.has(other) || second.has(other)) continue;
            second.set(other, { ...names.get(other), chainId: other, anchor, role: roleOf(e, anchor), source: e.source });
        }
    }
    return { direct, second };
}

// The summary's relations, before the graph answers: enough for the headline count.
function relationCounts(chainId) {
    const e = state.rel.get(chainId);
    if (!e) return null;
    const parts = [
        [e.l2Children?.length || 0, 'L2 / L3'],
        [e.testnetChildren?.length || 0, 'testnet'],
        [e.l1Parent != null ? 1 : 0, 'settles on'],
        [e.mainnet != null ? 1 : 0, 'testnet of']
    ].filter(([n]) => n);
    const total = parts.reduce((a, [n]) => a + n, 0);
    return total ? { total, sub: parts.map(([n, l]) => `${n} ${l}`).join(' · ') } : null;
}

function renderRelationGraph(card, chainId, g) {
    const { direct, second } = relationRolesOf(g, chainId);
    const body = cardBody(card);
    if (!direct.size) {
        body.appendChild(emptyNote('No related networks recorded in any source.'));
        return;
    }
    setCardMeta(card, `${fmtNum(direct.size)} direct · ${fmtNum(second.size)} second hop`);

    const controls = el('div', { class: 'pf-graph-controls' });
    const legend = el('div', { class: 'chip-row', role: 'group', 'aria-label': 'Relations shown' });
    const depthRow = el('div', { class: 'chip-row', role: 'group', 'aria-label': 'Graph depth' });
    controls.append(legend, depthRow);
    const stage = el('div', { class: 'pf-graph' });
    body.append(controls, stage);

    const draw = () => drawRelationGraph(stage, chainId, direct, second);
    profile.redrawGraph = draw;
    for (const role of ROLE_ORDER) {
        const n = [...direct.values()].filter(x => x.role === role).length;
        if (!n) continue;
        const chip = el('button', {
            class: 'chip', type: 'button', 'aria-pressed': String(!profile.hiddenRoles.has(role)),
            onclick: () => {
                if (profile.hiddenRoles.has(role)) profile.hiddenRoles.delete(role); else profile.hiddenRoles.add(role);
                chip.setAttribute('aria-pressed', String(!profile.hiddenRoles.has(role)));
                draw();
            }
        }, [el('span', { class: `pf-role-key pf-role-${role}` }), ROLE_LABEL[role], el('span', { class: 'chip-count', text: String(n) })]);
        legend.appendChild(chip);
    }
    if (second.size) {
        for (const [depth, label] of [[1, 'Direct'], [2, 'Second hop']]) {
            const chip = el('button', {
                class: 'chip', type: 'button', 'aria-pressed': String(profile.depth === depth),
                onclick: () => {
                    profile.depth = depth;
                    for (const b of depthRow.children) b.setAttribute('aria-pressed', String(b === chip));
                    draw();
                }
            }, [label]);
            depthRow.appendChild(chip);
        }
    }
    draw();
    // Laid out in real pixels so labels keep their size; redrawn when the card's width moves
    // away from the width it was drawn at (the first draw can run before the page settles).
    profile.graphResize = new ResizeObserver(() => {
        if (Math.abs(stage.clientWidth - Number(stage.dataset.drawnWidth || 0)) < 24) return;
        draw();
    });
    profile.graphResize.observe(stage);

    body.appendChild(renderRelationList(direct, second));
}

function drawRelationGraph(stage, chainId, direct, second) {
    clear(stage);
    Viz.hideTip();
    const W = Math.max(300, stage.clientWidth || 800);
    stage.dataset.drawnWidth = String(W);
    const H = Math.round(Math.min(620, Math.max(320, W * 0.62)));
    const cx = W / 2, cy = H / 2;
    const showSecond = profile.depth === 2;
    const firstRing = [...direct.values()]
        .filter(n => !profile.hiddenRoles.has(n.role))
        // By name within a role, so the largest networks spread around the ring rather than
        // sitting side by side with their labels on top of each other.
        .sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || nameOf(a).localeCompare(nameOf(b)));
    const kids = new Map();
    const hiddenKids = new Map();
    if (showSecond) {
        for (const n of second.values()) {
            if (!firstRing.some(f => f.chainId === n.anchor)) continue;
            if (!kids.has(n.anchor)) kids.set(n.anchor, []);
            kids.get(n.anchor).push(n);
        }
        for (const [anchor, list] of kids) {
            list.sort((a, b) => tvsOf(b.chainId) - tvsOf(a.chainId) || nameOf(a).localeCompare(nameOf(b)));
            if (list.length > GRAPH_KIDS_SHOWN) hiddenKids.set(anchor, list.splice(GRAPH_KIDS_SHOWN));
        }
    }
    const svg = Viz.svgEl('svg', {
        class: 'pf-graph-svg', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img',
        'aria-label': `Relationship graph: ${firstRing.length} related networks${showSecond ? ' and their own relations' : ''}. The list below has the same data.`
    });
    stage.appendChild(svg);
    if (!firstRing.length) {
        svg.appendChild(Viz.svgEl('text', { x: cx, y: cy, 'text-anchor': 'middle', class: 'pf-g-label', text: 'Every relation is hidden — pick one above.' }));
        return;
    }

    // Angles: each direct neighbour gets a share of the circle weighted by the second-hop
    // nodes it carries, starting at the top so what this chain settles on sits above it.
    const weight = n => 1 + (kids.get(n.chainId)?.length || 0) * 0.6;
    const total = firstRing.reduce((a, n) => a + weight(n), 0);
    const r1 = Math.min(W, H) * (showSecond && kids.size ? 0.27 : 0.38);
    const r2 = Math.min(W * 0.47, H * 0.46);
    const pos = new Map([[chainId, { x: cx, y: cy }]]);
    const overflow = [];
    let acc = 0;
    for (const n of firstRing) {
        const w = weight(n);
        const a0 = -Math.PI / 2 + (acc / total) * 2 * Math.PI;
        const a1 = -Math.PI / 2 + ((acc + w) / total) * 2 * Math.PI;
        acc += w;
        const mid = (a0 + a1) / 2;
        pos.set(n.chainId, { x: cx + r1 * Math.cos(mid), y: cy + r1 * Math.sin(mid), angle: mid });
        const list = kids.get(n.chainId) || [];
        list.forEach((k, i) => {
            const a = list.length === 1 ? mid : a0 + (a1 - a0) * ((i + 0.5) / list.length);
            pos.set(k.chainId, { x: cx + r2 * Math.cos(a), y: cy + r2 * Math.sin(a), angle: a });
        });
        if (hiddenKids.has(n.chainId)) overflow.push({ anchor: n, count: hiddenKids.get(n.chainId).length, angle: mid });
    }

    const maxTvs = Math.max(1, ...[...pos.keys()].map(tvsOf));
    const radius = id => {
        if (id === chainId) return 14;
        const tvs = tvsOf(id);
        return tvs > 0 ? 4 + 9 * Math.sqrt(tvs / maxTvs) : 4;
    };
    const edges = Viz.svgEl('g', { class: 'pf-g-edges' });
    const nodes = Viz.svgEl('g', { class: 'pf-g-nodes' });
    const labels = Viz.svgEl('g', { class: 'pf-g-labels', 'aria-hidden': 'true' });
    svg.append(edges, nodes, labels);
    const edgeOf = new Map();
    const line = (a, b, role) => {
        const p = pos.get(a), q = pos.get(b);
        const ln = Viz.svgEl('line', { x1: p.x, y1: p.y, x2: q.x, y2: q.y, class: `pf-g-edge pf-g-edge-${role}` });
        edges.appendChild(ln);
        for (const id of [a, b]) { if (!edgeOf.has(id)) edgeOf.set(id, []); edgeOf.get(id).push(ln); }
    };
    for (const n of firstRing) {
        line(chainId, n.chainId, n.role);
        for (const k of kids.get(n.chainId) || []) line(n.chainId, k.chainId, k.role);
    }

    // Labels for the few nodes that matter most — the centre, what it settles on or is a
    // testnet of, and the largest by value secured. Everything else names itself on hover.
    const labelled = new Set([chainId]);
    for (const n of firstRing) if (n.role === 'parent' || n.role === 'mainnet') labelled.add(n.chainId);
    const budget = Math.max(6, Math.floor(W / 70));
    const ranked = [...pos.keys()].filter(id => id !== chainId).sort((a, b) => tvsOf(b) - tvsOf(a) || (direct.has(b) - direct.has(a)));
    for (const id of ranked) { if (labelled.size >= budget) break; if (firstRing.length <= budget || tvsOf(id) > 0) labelled.add(id); }

    // Labels skip a spot another label already took, estimated from the text length.
    const taken = [];
    const placeLabel = (x, y, anchor, text, cls, flip = null) => {
        const w = text.length * (cls.includes('is-center') ? 7.4 : 6.2);
        // A label that would run off the canvas goes on the node's other side.
        if (anchor === 'start' && x + w > W - 2 && flip != null) { x = flip; anchor = 'end'; }
        else if (anchor === 'end' && x - w < 2 && flip != null) { x = flip; anchor = 'start'; }
        const left = anchor === 'start' ? x : anchor === 'end' ? x - w : x - w / 2;
        const box = { l: left - 2, r: left + w + 2, t: y - 11, b: y + 3 };
        if (!cls.includes('is-center') && taken.some(o => box.l < o.r && box.r > o.l && box.t < o.b && box.b > o.t)) return;
        taken.push(box);
        labels.appendChild(Viz.svgEl('text', { x, y, 'text-anchor': anchor, class: cls, text }));
    };
    const drawNode = (id, info) => {
        const p = pos.get(id);
        const c = state.byId.get(id) || info || {};
        const cls = c.tags ? netClass(c) : NET_CLASSES.other;
        const g = Viz.svgEl('g', { class: `pf-g-node${id === chainId ? ' is-center' : ''}`, transform: `translate(${p.x},${p.y})` });
        g.appendChild(Viz.svgEl('circle', { r: Math.max(radius(id) + 6, 11), class: 'pf-g-hit' }));
        const dot = Viz.svgEl('circle', { r: radius(id), class: 'pf-g-dot' });
        dot.style.fill = Viz.cssVar(cls.cssVar);
        g.appendChild(dot);
        nodes.appendChild(g);
        if (id !== chainId) {
            const tvs = tvsOf(id);
            const anchorName = info?.anchor != null ? (state.byId.get(info.anchor)?.name || `Chain ${info.anchor}`) : null;
            Viz.bindTip(g, {
                value: c.name || `Chain ${id}`,
                title: `ID ${id} · ${cls.label}`,
                rows: [
                    { label: anchorName ? `${ROLE_LABEL[info.role]} of` : 'Relation', value: anchorName ? `${anchorName}` : ROLE_LABEL[info.role] },
                    tvs > 0 ? { label: 'Value secured', value: fmtUsd(tvs) } : null,
                    info?.source ? { label: 'Source', value: info.source } : null
                ].filter(Boolean),
                note: 'Click to open its profile'
            });
            g.setAttribute('role', 'link');
            g.setAttribute('aria-label', `${c.name || `Chain ${id}`}, ${ROLE_LABEL[info.role]}`);
            g.addEventListener('click', () => openChainProfile(id));
            g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openChainProfile(id); } });
            g.addEventListener('pointerenter', () => { svg.classList.add('is-focusing'); for (const l of edgeOf.get(id) || []) l.classList.add('is-on'); });
            g.addEventListener('pointerleave', () => { svg.classList.remove('is-focusing'); for (const l of edgeOf.get(id) || []) l.classList.remove('is-on'); });
        }
        if (labelled.has(id)) {
            const right = id === chainId || Math.cos(p.angle ?? 0) >= 0;
            const off = radius(id) + 4;
            placeLabel(
                id === chainId ? p.x : p.x + (right ? off : -off),
                id === chainId ? p.y + radius(id) + 14 : p.y + 4,
                id === chainId ? 'middle' : (right ? 'start' : 'end'),
                Viz.truncate(c.name || `Chain ${id}`, 22),
                `pf-g-label${id === chainId ? ' is-center' : ''}`,
                id === chainId ? null : p.x + (right ? -off : off)
            );
        }
    };
    // The centre's label first, then the largest, so a collision drops the lesser one.
    drawNode(chainId, null);
    const order = [...firstRing.flatMap(n => kids.get(n.chainId) || []), ...firstRing]
        .sort((a, b) => tvsOf(b.chainId) - tvsOf(a.chainId));
    for (const n of order) drawNode(n.chainId, n);
    for (const o of overflow) {
        const r = r2 + 18;
        const right = Math.cos(o.angle) >= 0;
        const x = cx + r * Math.cos(o.angle);
        const text = W < 600 ? `+${o.count} more` : `+${o.count} more of ${Viz.truncate(nameOf(o.anchor), 18)}`;
        placeLabel(x, cy + r * Math.sin(o.angle) + 4, Math.abs(Math.cos(o.angle)) < 0.3 ? 'middle' : (right ? 'start' : 'end'),
            text, 'pf-g-label pf-g-more', right ? x - 8 : x + 8);
    }
}

function tvsOf(chainId) { return state.l2beat.get(chainId)?.tvs || 0; }
function nameOf(n) { return state.byId.get(n.chainId)?.name || n.name || `Chain ${n.chainId}`; }

// The same relations as a list: the graph's accessible twin, and where each relation's source shows.
function renderRelationList(direct, second) {
    const wrap = el('div', { class: 'pf-rel-list' });
    for (const role of ROLE_ORDER) {
        const group = [...direct.values()].filter(n => n.role === role)
            .sort((a, b) => tvsOf(b.chainId) - tvsOf(a.chainId) || a.chainId - b.chainId);
        if (!group.length) continue;
        const items = group.map(n => {
            const link = el('span', { title: n.source ? `Source: ${n.source}` : null }, [chainProfileLink(n.chainId)]);
            const below = [...second.values()].filter(k => k.anchor === n.chainId)
                .sort((a, b) => tvsOf(b.chainId) - tvsOf(a.chainId) || nameOf(a).localeCompare(nameOf(b)));
            if (!below.length) return el('span', { class: 'pf-rel-item' }, [link]);
            // Its own relations, every one (the graph draws only the first few): name, what it
            // is to this neighbour, and the source that says so.
            return el('details', { class: 'pf-rel-item pf-rel-sub' }, [
                el('summary', {}, [link, el('span', { class: 'chip-count', text: ` +${below.length}` })]),
                el('div', { class: 'pf-chips' }, below.map(k => el('span', {
                    class: 'pf-rel-item',
                    title: `${ROLE_LABEL[k.role]} of ${nameOf(n)}${k.source ? ` · source: ${k.source}` : ''}`
                }, [chainProfileLink(k.chainId), el('span', { class: 'dim', text: ` ${ROLE_SHORT[k.role]}` })])))
            ]);
        });
        wrap.appendChild(detailRow(`${ROLE_LABEL[role]} (${group.length})`, moreList(items, { shown: 24, cls: 'pf-chips' })));
    }
    return wrap;
}

// ── RPC endpoints ─────────────────────────────────────────────────────────
// The registry's list joined to the monitor's probe results. The monitor samples a few
// endpoints per chain, so most rows are listed but not probed, and the table says which.
function renderProfileRpc(card, chainId, mon, eps, kpi) {
    const body = cardBody(card);
    const probed = new Map((mon?.endpoints || []).map(r => [r.url, r]));
    const listed = (eps?.rpc || []).map(u => (typeof u === 'string' ? u : u?.url)).filter(Boolean);
    const urls = [...new Set([...probed.keys(), ...listed])];
    const working = [...probed.values()].filter(r => r.status === 'working');
    // A rate-limited probe is no verdict (the provider refused our volume), so like /stats the
    // figure judges only endpoints that answered or failed.
    const judged = [...probed.values()].filter(r => r.status === 'working' || r.status === 'failed');
    const limited = probed.size - judged.length;
    if (judged.length) {
        kpi.rpc = {
            label: 'RPC endpoints', value: `${working.length} / ${judged.length}`,
            sub: `working of probed${limited ? ` · ${limited} rate-limited` : ''} · ${fmtNum(urls.length)} listed`,
            tone: working.length ? (working.length === judged.length ? 'good' : 'warn') : 'critical',
            meter: (working.length / judged.length) * 100
        };
    } else if (limited) {
        kpi.rpc = { label: 'RPC endpoints', value: '—', sub: `${limited} probed, all rate-limited · ${fmtNum(urls.length)} listed` };
    } else if (urls.length) {
        kpi.rpc = { label: 'RPC endpoints', value: fmtNum(urls.length), sub: 'listed, not yet probed' };
    }
    setCardMeta(card, !mon ? 'probe results unavailable' : mon.lastUpdated ? `probed ${relTime(mon.lastUpdated)}` : 'not probed yet');

    const head = el('span', { class: 'mono', text: '…' });
    body.appendChild(detailRow('Block head', head));
    const browserUrls = [...new Set([...working.map(r => r.url), ...listed])].filter(u => u.startsWith('http') && !u.includes('${'));
    if (browserUrls.length) startHeadPoller(profile.head, browserUrls, head); else head.textContent = '—';

    if (!urls.length) body.appendChild(emptyNote('No RPC endpoints in any registry.'));
    const order = u => {
        const r = probed.get(u);
        return r ? ({ working: 0, failed: 1 }[r.status] ?? 2) : u.includes('${') ? 4 : 3;
    };
    const rows = urls.sort((a, b) => order(a) - order(b)).map(u => {
        const r = probed.get(u);
        const keyed = u.includes('${');
        const status = r ? (r.status === 'rate_limited' ? 'rate-limited' : r.status) : keyed ? 'needs key' : 'listed';
        const dot = r?.status === 'working' ? 'dot-ok' : r?.status === 'failed' ? 'dot-bad' : 'dot-idle';
        return el('div', { class: 'pf-rpc-row' }, [
            el('span', { class: `dot ${dot}` }),
            el('span', { class: 'pf-rpc-url code', title: u, text: u }),
            el('span', { class: 'pf-rpc-state', text: status }),
            el('span', { class: 'pf-rpc-meta dim', text: [r?.blockNumber != null ? `#${r.blockNumber.toLocaleString()}` : null, clientNameVersion(r?.clientVersion), r?.error].filter(Boolean).join(' · ') })
        ]);
    });
    if (rows.length) body.appendChild(moreList(rows, { shown: 10 }));
    const extra = [['Firehose', eps?.firehose], ['Substreams', eps?.substreams]].filter(([, l]) => l?.length);
    for (const [label, list] of extra) body.appendChild(detailRow(label, el('span', { class: 'code', text: list.join(', ') })));
}

function renderProfileLiveClients(card, mon) {
    const body = cardBody(card);
    const clients = mon?.clients || [];
    if (!clients.length) { body.appendChild(emptyNote('No probed node has reported its client yet.')); return; }
    for (const cl of clients) {
        const versions = (cl.versions || []).map(v => `${v.version}${v.nodeCount ? ` ×${v.nodeCount}` : ''}`).join(' · ');
        body.appendChild(detailRow(cl.name, el('div', {}, [
            el('span', { text: [cl.layer, cl.language].filter(Boolean).join(' · ') || (cl.known ? '' : 'unrecognised client') }),
            cl.repo ? el('span', {}, [' · ', extLink(`https://github.com/${cl.repo}`, cl.repo)]) : null,
            versions ? el('div', { class: 'dim mono', text: versions }) : null
        ])));
    }
    body.appendChild(el('div', { class: 'r-foot dim', text: 'From web3_clientVersion on the endpoints the monitor probes.' }));
}

// ── hardforks ─────────────────────────────────────────────────────────────
function forkWhen(f) {
    const at = Date.parse(f.activationAt || '');
    if (Number.isFinite(at)) {
        return f.activationPrecision === 'day' || isDateOnlyActivation(f.activationAt)
            ? new Date(at).toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' })
            : fmtDateTime(at);
    }
    return undatedWhenText(f);
}
function renderProfileForks(card, d, kpi) {
    const body = cardBody(card);
    if (!d) { body.appendChild(emptyNote('The fork feeds could not be read.')); return; }
    const forks = d.forks || [];
    if (!forks.length) { body.appendChild(emptyNote('No hardfork recorded for this network.')); return; }
    const ms = f => Date.parse(f.activationAt || '') || 0;
    const rank = { upcoming: 0, unscheduled: 1, past: 2, cancelled: 3 };
    forks.sort((a, b) => (rank[a.phase] ?? 4) - (rank[b.phase] ?? 4) || (a.phase === 'upcoming' ? ms(a) - ms(b) : ms(b) - ms(a)));
    // The response's own totals: the list is capped, the counts are not.
    const total = d.totalMatched ?? forks.length;
    const upcoming = d.byPhase?.upcoming ?? forks.filter(f => f.phase === 'upcoming').length;
    kpi.forks = { label: 'Hardforks', value: fmtNum(total), sub: upcoming ? `${upcoming} upcoming` : 'none upcoming', tone: upcoming ? 'warn' : null };
    setCardMeta(card, d.truncated ? `${fmtNum(total)} known · showing ${fmtNum(forks.length)}` : `${fmtNum(total)} known`);
    const rows = forks.map(f => {
        const ev = evidenceOf(f);
        const link = (f.events || []).find(e => e.url)?.url;
        return el('div', { class: `pf-fork-row${f.phase === 'upcoming' ? ' pending' : ''}` }, [
            el('span', { class: 'pf-fork-when mono', title: ev.title, text: forkWhen(f) }),
            el('div', {}, [
                el('span', { class: 'pf-fork-name' }, [link ? extLink(link, f.name || 'Unnamed fork') : el('span', { text: f.name || 'Unnamed fork' })]),
                el('div', { class: 'dim', text: [f.phase, `${(f.sources || []).length} source${(f.sources || []).length === 1 ? '' : 's'}`].join(' · ') })
            ]),
            el('span', { class: `tlx-chip-ev ${ev.cls}`, title: ev.title, text: ev.label })
        ]);
    });
    body.appendChild(moreList(rows));
}

function renderProfileEvents(card, d) {
    const body = cardBody(card);
    if (!d) { body.appendChild(emptyNote('The timeline could not be read.')); return; }
    // Newest first; undated last.
    const items = [...new Map(d.entries.map(e => [e.id, e])).values()]
        .sort((a, b) => (Date.parse(b.activationAt || '') || 0) - (Date.parse(a.activationAt || '') || 0));
    if (!items.length) { body.appendChild(emptyNote('No software updates or maintenance on record.')); return; }
    const rows = items.map(u => el('div', { class: 'pf-event-row' }, [
        el('span', { class: 'pf-fork-when mono', text: forkWhen(u) }),
        el('div', {}, [
            u.url ? extLink(u.url, u.name || u.title) : el('span', { text: u.name || u.title }),
            el('div', { class: 'dim', text: [TL_TYPE_LABEL[u.type] || u.type, u.provider, (u.feeds || []).join(', ')].filter(Boolean).join(' · ') })
        ])
    ]));
    body.appendChild(moreList(rows, { shown: 6 }));
}

// ── scaling & activity ───────────────────────────────────────────────────
function renderProfileActivity(card, c, l2b, kpi) {
    const m = c.l2Metrics;
    if (!l2b && !m) return;
    const body = cardBody(card);
    const row = (label, value, title) => body.appendChild(detailRow(label, el('span', { title, text: value })));
    if (l2b) {
        if (l2b.tvs != null) row('Value secured', fmtUsd(l2b.tvs), 'L2BEAT total value secured');
        if (l2b.stage) row('Stage', l2b.stage);
        if (l2b.category) row('Category', l2b.category);
        if (l2b.stack) row('Stack', l2b.stack);
        if (l2b.daLayer) row('Data availability', l2b.daLayer);
    }
    if (m) {
        if (m.chainType) row('Chain type', m.chainType);
        if (!l2b && m.stack) row('Stack', m.stack);
        const daa = m.metrics?.daa;
        if (Number.isFinite(daa?.value)) {
            const asOf = daa.date ? ` on ${daa.date}` : '';
            row('Daily active addresses', fmtNum(daa.value), `Daily active addresses${asOf}, from growthepie`);
            kpi.users = { label: 'Daily active addresses', value: fmtNum(daa.value), sub: `${daa.date || 'latest day'} · growthepie` };
        }
        if (m.txcostMedianUsd != null) {
            row('Median tx cost', `$${m.txcostMedianUsd}`, 'Median transaction fee, from growthepie');
            kpi.txcost = { label: 'Median tx cost', value: `$${m.txcostMedianUsd}`, sub: 'growthepie' };
        }
        if (m.url) body.appendChild(detailRow('Source', extLink(m.url, 'growthepie')));
    }
    card.classList.remove('hidden');
}

// ── node hardware ─────────────────────────────────────────────────────────
// research.hardware: the sizing a network's own documentation publishes, per node role and
// level, each requirement with its qualifier and source. Shown as the documents state it; units
// are not converted.
const HW_STATUS_TEXT = {
    documented: 'Documented by the project',
    partial: 'Partly documented',
    not_found: 'No published hardware requirements found',
    inaccessible: 'Requirements page could not be read'
};
const HW_COMPONENTS = [['cpu', 'CPU'], ['memory', 'Memory'], ['storage', 'Storage'], ['network', 'Network'], ['operating_system', 'OS'], ['other', 'Other']];
const HW_SCOPE_TEXT = { exact_network: 'this network', project_family: 'project-wide', historical_network: 'historical network', uncertain: 'scope uncertain' };
const HW_QUALIFIER = { at_least: '≥ ', at_most: '≤ ', approximately: '~ ', minimum: '≥ ' };
const words = v => String(v ?? '').replace(/_/g, ' ');

function hwValue(r) {
    const unit = r.unit ? ` ${r.unit}` : '';
    const v = r.qualifier === 'range' && (r.min != null || r.max != null)
        ? `${r.min ?? '?'}–${r.max ?? '?'}${unit}`
        : `${HW_QUALIFIER[r.qualifier] ?? ''}${typeof r.value === 'number' ? r.value.toLocaleString() : (r.value ?? '?')}${r.value != null ? unit : ''}`;
    // The metric is named unless it is what the component means by default.
    const plain = { cpu: ['cores'], memory: ['capacity'], storage: ['capacity'], network: ['bandwidth'], operating_system: ['os_version'] };
    // …or when the unit already says it ("8 threads", "50,000 IOPS"), or the value is text.
    const said = r.unit && String(r.unit).toLowerCase().includes(String(r.metric).toLowerCase());
    const metric = plain[r.component]?.includes(r.metric) || r.metric === 'other' || said || typeof r.value === 'string' ? '' : `${words(r.metric)} `;
    return `${metric}${v}${r.qualifier === 'suggested' ? ' (suggested)' : ''}`;
}

function hwTitle(p) { return [words(p.role), words(p.level)].filter(x => x && x !== 'unspecified').join(' · ') || 'node'; }
// Profiles sharing a role and level (Ethereum's attester and local-builder validators) are told
// apart by their own id.
function hwProfile(p, shared) {
    const title = shared ? `${hwTitle(p)} · ${words(String(p.id || '').replace(/-(minimum|recommended|example)$/, '')).replace(/-/g, ' ')}` : hwTitle(p);
    const head = el('div', { class: 'pf-hw-head' }, [
        el('span', { class: 'pf-hw-title', text: title }),
        p.client ? el('span', { class: 'pf-hw-client', text: [p.client, p.clientVersion].filter(Boolean).join(' ') }) : null,
        el('span', { class: 'pill-meta', title: 'What the requirement applies to', text: HW_SCOPE_TEXT[p.scope] || words(p.scope) }),
        p.deployment && p.deployment !== 'unknown' ? el('span', { class: 'pill-meta', text: words(p.deployment) }) : null,
        el('span', {
            class: `pill-meta pf-hw-verify pf-hw-${p.verification}`,
            title: p.verificationNotes || null,
            text: p.verification === 'confirmed' ? 'verified' : words(p.verification)
        })
    ]);
    const rows = [];
    for (const [key, label] of HW_COMPONENTS) {
        const reqs = (p.requirements || []).filter(r => r.component === key);
        if (!reqs.length) continue;
        rows.push(el('div', { class: 'pf-hw-row' }, [
            el('span', { class: 'pf-hw-label', text: label }),
            el('span', { class: 'pf-hw-values' }, reqs.flatMap((r, i) => [
                i ? ' · ' : null,
                el('span', { title: [r.notes, r.source && `Source: ${r.source}`].filter(Boolean).join('\n') || null, text: hwValue(r) + (r.notes && r.notes.length <= 24 ? ` (${r.notes})` : '') })
            ]))
        ]));
    }
    return el('div', { class: 'pf-hw-profile' }, [
        head,
        ...rows,
        p.notes ? longNote(p.notes) : null,
        p.evidence?.length ? el('div', { class: 'pf-hw-note' }, p.evidence.slice(0, 3).flatMap((u, i) => [i ? ' · ' : null, extLink(u, safeHost(u) || 'source')])) : null
    ]);
}

// Research notes run to a paragraph or more: the first lines, the rest behind a toggle.
const NOTE_SHOWN_CHARS = 220;
function longNote(text) {
    if (text.length <= NOTE_SHOWN_CHARS) return el('p', { class: 'dim pf-hw-note', text });
    const cut = text.lastIndexOf(' ', NOTE_SHOWN_CHARS);
    const rest = el('span', { class: 'hidden', text: text.slice(cut) });
    const more = el('button', { class: 'pf-note-more', type: 'button', 'aria-expanded': 'false', text: 'Show more' });
    const dots = el('span', { text: '… ' });
    more.addEventListener('click', () => {
        const open = rest.classList.toggle('hidden') === false;
        dots.textContent = open ? ' ' : '… ';
        more.textContent = open ? 'Show less' : 'Show more';
        more.setAttribute('aria-expanded', String(open));
    });
    return el('p', { class: 'dim pf-hw-note' }, [text.slice(0, cut), rest, dots, more]);
}

function renderProfileHardware(card, hw) {
    card.querySelector('.pf-body')?.remove();
    if (!hw) { card.classList.add('hidden'); return; }
    const body = cardBody(card);
    const profiles = hw.profiles || [];
    setCardMeta(card, [HW_STATUS_TEXT[hw.status] || words(hw.status), hw.checkedAt && `checked ${relTime(hw.checkedAt)}`].filter(Boolean).join(' · '));
    if (profiles.length) {
        const count = new Map();
        for (const p of profiles) count.set(hwTitle(p), (count.get(hwTitle(p)) || 0) + 1);
        body.appendChild(el('div', { class: 'pf-hw-grid' }, profiles.map(p => hwProfile(p, count.get(hwTitle(p)) > 1))));
    } else {
        body.appendChild(emptyNote(`${HW_STATUS_TEXT[hw.status] || 'No hardware requirements on record'} for this network.`));
    }
    if (hw.notes) body.appendChild(longNote(hw.notes));
    if (hw.sources?.length) {
        body.appendChild(detailRow('Sources', hw.sources.map(src => extLink(src.url, src.title || safeHost(src.url)))));
    }
    body.appendChild(el('div', { class: 'r-foot dim', text: 'As the project documents it, per node role; units as published. Project-wide figures may cover several networks of the family.' }));
    card.classList.remove('hidden');
}

// ── data quality ──────────────────────────────────────────────────────────
function renderProfileQuality(card, chainId, d) {
    const body = cardBody(card);
    if (!d) { body.appendChild(emptyNote('Validation results could not be read.')); return; }
    // Filtered here too: an API from before ?chainId answers with the whole report.
    const findings = (d.allErrors || []).filter(f => f.chainId === chainId);
    const notices = findings.filter(f => f.severity === 'notice').length;
    setCardMeta(card, findings.length
        ? `${findings.length - notices} error${findings.length - notices === 1 ? '' : 's'} · ${notices} notice${notices === 1 ? '' : 's'}`
        : 'no findings');
    if (!findings.length) {
        body.appendChild(emptyNote('No validation rule flags this network: its sources agree with each other and with its probed RPC endpoints.'));
        return;
    }
    body.appendChild(moreList(findings.map(f => el('div', { class: 'pf-finding' }, [
        el('span', {
            class: `pill ${f.severity === 'notice' ? 'pill-stage' : 'pill-deprecated'}`,
            title: f.severity === 'notice' ? 'Notice: worth knowing, not wrong' : 'Error: a source should fix it',
            text: `rule ${f.rule} · ${f.severity === 'notice' ? 'notice' : 'error'}`
        }),
        el('span', { text: f.message || f.type })
    ])), { shown: 6 }));
    body.appendChild(el('div', { class: 'r-foot dim', text: 'Where the sources disagree with each other or with what the chain serves. Each one is a candidate fix upstream.' }));
}

// ── raw records ──────────────────────────────────────────────────────────
function renderProfileRaw(card, chainId) {
    const body = cardBody(card);
    const records = [
        ['Chain record', `/chains/${chainId}`],
        ['Relations', `/relations/${chainId}`],
        ['RPC endpoints', `/endpoints/${chainId}`],
        ['RPC monitor', `/rpc-monitor/${chainId}`],
        ['Clients', `/clients/${chainId}`],
        ['Hardforks', `/forks?chainId=${chainId}&limit=200`],
        ['Validation', `/validate?chainId=${chainId}`]
    ];
    for (const [label, path] of records) {
        const pre = el('pre', { class: 'pf-json' });
        const details = el('details', { class: 'pf-raw' }, [
            el('summary', {}, [label, ' ', el('span', { class: 'code dim', text: path })]),
            pre
        ]);
        details.addEventListener('toggle', () => {
            if (!details.open || pre.textContent) return;
            pre.textContent = 'Loading…';
            profileFetch(path).then(v => { pre.textContent = JSON.stringify(v, null, 2); }, err => { pre.textContent = `Not available (${err.status || err.message}).`; });
        });
        body.appendChild(details);
    }
    body.appendChild(el('div', { class: 'r-foot dim' }, ['The records this page is built from, as the API serves them. ', extLink(`${API_BASE}/docs`, 'API reference')]));
}
