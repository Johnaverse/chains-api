// Chains — admin: review and triage cross-source data conflicts.
//
// The conflicts are what GET /validate's 17 rules find: places where the five upstream sources
// disagree about a chain. An admin can acknowledge one (real, being tracked), dismiss it (a
// false positive or accepted noise — the reason is required, because it hides the conflict from
// everyone), or reopen it. Decisions persist across refreshes; a dismissed conflict comes back
// open by itself if the disagreement changes, and one that stops occurring shows as resolved.
//
// Needs a signed-in session. No framework and no inline script: the API serves this file
// under `script-src 'self'`. Evidence and notes are untrusted text, so every value reaches the
// page through textContent, never innerHTML.
'use strict';

(() => {
    const SAME_ORIGIN_API =
        location.port === '3000' || location.hostname === 'chains-api.johnaverse.cc'
        || location.pathname.startsWith('/ui');
    const API_BASE = SAME_ORIGIN_API ? '' : 'https://chains-api.johnaverse.cc';
    const PAGE = 50;

    const main = document.getElementById('adminMain');
    const nav = document.getElementById('adminNav');

    const state = {
        user: null,
        filter: { state: 'open', rule: null, q: '' },
        data: null,
        items: [],
        showResolved: false,
        historyOpen: false,
        busy: false,
        // Every load gets a number, and only the newest may render. Clicking a tab and then
        // typing a search fires two requests; without this, whichever response arrives LAST
        // wins — so a stale, unfiltered list could land under a search box that says "bnb".
        loadSeq: 0
    };

    // ── helpers ──────────────────────────────────────────────────────────────

    function el(tag, props = {}, children = []) {
        const node = document.createElement(tag);
        for (const [k, v] of Object.entries(props)) {
            if (v == null || v === false) continue;
            if (k === 'class') node.className = v;
            else if (k === 'text') node.textContent = v;
            else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
            else if (v === true) node.setAttribute(k, '');
            else node.setAttribute(k, v);
        }
        for (const c of [].concat(children)) {
            if (c == null || c === false) continue;
            node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
        }
        return node;
    }

    async function api(path, body) {
        const init = { method: body ? 'POST' : 'GET', credentials: 'include', headers: {} };
        if (body) {
            init.headers['content-type'] = 'application/json';
            init.body = JSON.stringify(body);
        }
        let res;
        try {
            res = await fetch(API_BASE + path, init);
        } catch {
            return { status: 0, ok: false, data: null };
        }
        let data = null;
        try { data = await res.json(); } catch { /* 204 */ }
        return { status: res.status, ok: res.ok, data };
    }

    function when(iso) {
        try {
            return new Date(iso).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        } catch {
            return iso;
        }
    }

    const STATE_LABEL = { open: 'Open', acknowledged: 'Acknowledged', dismissed: 'Dismissed' };
    const ACTION_LABEL = { acknowledged: 'acknowledged', dismissed: 'dismissed', reopened: 'reopened', pruned: 'cleared (no longer occurs)' };

    function chainTitle(item) {
        const name = item.chainName || 'Unnamed chain';
        return item.chainId != null ? `${name} · #${item.chainId}` : name;
    }

    // ── gates ────────────────────────────────────────────────────────────────

    function gate(title, lead, actions) {
        nav.hidden = true;
        main.replaceChildren(el('section', { class: 'admin-gate' }, [
            el('h1', { class: 'auth-title', text: title }),
            el('p', { class: 'auth-lead', text: lead }),
            el('p', { class: 'auth-row' }, actions)
        ]));
    }

    const signInGate = (lead = 'The admin area needs a signed-in account.') =>
        gate('Sign in to manage conflicts', lead, [
            el('a', { class: 'auth-btn', href: 'login.html?next=admin.html', text: 'Sign in' }),
            el('a', { class: 'auth-link', href: './', text: 'Back to the dashboard' })
        ]);

    // ── loading ──────────────────────────────────────────────────────────────

    async function load({ append = false } = {}) {
        const seq = ++state.loadSeq;
        const params = new URLSearchParams({ state: state.filter.state, limit: String(PAGE), offset: String(append ? state.items.length : 0) });
        if (state.filter.rule) params.set('rule', String(state.filter.rule));
        if (state.filter.q.trim()) params.set('q', state.filter.q.trim());

        const r = await api(`/admin/conflicts?${params}`);
        if (seq !== state.loadSeq) return; // a newer request superseded this one
        if (r.status === 401) return signInGate('Your session ended. Sign in again to continue.');
        if (r.status === 503) {
            return gate('Data is still loading', 'The server has not finished loading its sources, so conflicts cannot be computed yet.', [
                el('button', { class: 'auth-btn', type: 'button', text: 'Try again', onclick: () => load() })
            ]);
        }
        if (!r.ok) {
            return gate('Could not load conflicts', r.data?.error || 'Something went wrong.', [
                el('button', { class: 'auth-btn', type: 'button', text: 'Try again', onclick: () => load() })
            ]);
        }
        state.data = r.data;
        state.items = append ? state.items.concat(r.data.items) : r.data.items;
        render();
    }

    // ── actions ──────────────────────────────────────────────────────────────

    async function review(item, target, note, errorBox, form) {
        if (state.busy) return;
        state.busy = true;
        form.querySelectorAll('button').forEach((b) => { b.disabled = true; });
        const r = await api(`/admin/conflicts/${item.id}/review`, { state: target, note });
        state.busy = false;
        if (r.ok) return load();
        if (r.status === 401) return signInGate('Your session ended. Sign in again to continue.');
        form.querySelectorAll('button').forEach((b) => { b.disabled = false; });
        if (r.status === 404) {
            errorBox.textContent = 'This conflict no longer occurs — it may have been fixed upstream. Refreshing…';
            errorBox.hidden = false;
            setTimeout(() => load(), 1500);
            return;
        }
        errorBox.textContent = r.data?.error || 'Could not save the decision.';
        errorBox.hidden = false;
    }

    // One action per state change. Dismissing requires a reason; the others take an optional
    // note. The form opens inline so the evidence stays in view while deciding.
    function actionsFor(item) {
        const holder = el('div', { class: 'conflict-actions' });
        const formSlot = el('div');
        const choices = {
            open: [['acknowledged', 'Acknowledge'], ['dismissed', 'Dismiss']],
            acknowledged: [['dismissed', 'Dismiss'], ['open', 'Reopen']],
            dismissed: [['acknowledged', 'Acknowledge'], ['open', 'Reopen']]
        }[item.state] || [];

        function openForm(target, label) {
            const required = target === 'dismissed';
            const noteId = `note-${item.id}`;
            const note = el('textarea', {
                id: noteId, class: 'auth-input admin-note', rows: '3', maxlength: '1000',
                placeholder: required ? 'Why is this not a real problem?' : (target === 'acknowledged' ? 'e.g. reported upstream, link to the issue' : 'Optional'),
                required
            });
            const err = el('p', { class: 'auth-error', role: 'alert', hidden: true });
            // novalidate: the reason check below shows an inline, screen-reader-announced
            // message, matching the sign-in forms, instead of the browser's own tooltip.
            const form = el('form', { class: 'admin-form', novalidate: true }, [
                el('label', { for: noteId, class: 'auth-label', text: required ? 'Reason (required)' : 'Note (optional)' }),
                note,
                err,
                el('div', { class: 'conflict-actions' }, [
                    el('button', { class: 'auth-btn', type: 'submit', text: label }),
                    el('button', { class: 'auth-btn auth-btn-secondary', type: 'button', text: 'Cancel', onclick: () => { formSlot.replaceChildren(); holder.hidden = false; } })
                ])
            ]);
            form.addEventListener('submit', (e) => {
                e.preventDefault();
                const text = note.value.trim();
                if (required && !text) {
                    err.textContent = 'Say why this conflict is being dismissed.';
                    err.hidden = false;
                    note.focus();
                    return;
                }
                review(item, target, text, err, form);
            });
            holder.hidden = true;
            formSlot.replaceChildren(form);
            note.focus();
        }

        for (const [target, label] of choices) {
            holder.appendChild(el('button', {
                class: `auth-btn${target === 'acknowledged' ? '' : ' auth-btn-secondary'}`, type: 'button', text: label,
                onclick: () => openForm(target, label)
            }));
        }
        return [holder, formSlot];
    }

    // ── rendering ────────────────────────────────────────────────────────────

    function conflictCard(item) {
        const meta = item.review
            ? el('p', { class: 'conflict-review' }, [
                `${STATE_LABEL[item.review.state]} by ${item.review.by} on ${when(item.review.at)}`,
                item.review.note ? el('span', { class: 'conflict-note', text: ` — “${item.review.note}”` }) : null
            ])
            : null;
        return el('article', { class: 'conflict-card', 'data-id': item.id }, [
            el('div', { class: 'conflict-head' }, [
                el('span', { class: `state-pill state-${item.state}`, text: STATE_LABEL[item.state] }),
                el('span', { class: 'conflict-rule', text: `Rule ${item.rule} · ${item.ruleLabel}` }),
                item.severity ? el('span', { class: 'state-pill state-dismissed', text: item.severity }) : null
            ]),
            el('h2', { class: 'conflict-title', text: chainTitle(item) }),
            el('p', { class: 'conflict-message', text: item.message }),
            meta,
            el('details', { class: 'conflict-evidence' }, [
                el('summary', { text: item.occurrences > 1 ? `Evidence (${item.occurrences} identical findings)` : 'Evidence' }),
                el('pre', { text: JSON.stringify(item.evidence, null, 2) })
            ]),
            ...actionsFor(item)
        ]);
    }

    function tabs() {
        const c = state.data.counts;
        const defs = [['open', 'Open', c.open], ['acknowledged', 'Acknowledged', c.acknowledged], ['dismissed', 'Dismissed', c.dismissed], ['all', 'All', c.total]];
        return el('div', { class: 'admin-tabs', role: 'group', 'aria-label': 'Filter by review state' }, defs.map(([key, label, n]) =>
            el('button', {
                class: 'chip', type: 'button', 'aria-pressed': String(state.filter.state === key),
                onclick: () => { state.filter.state = key; load(); }
            }, [label, el('span', { class: 'chip-count', text: String(n) })])
        ));
    }

    function filters() {
        const select = el('select', { class: 'auth-input admin-select', id: 'ruleFilter', 'aria-label': 'Filter by rule' }, [
            el('option', { value: '', text: 'All rules' }),
            ...state.data.byRule.map((r) => el('option', {
                value: String(r.rule), text: `Rule ${r.rule} · ${r.label} (${r.open} open of ${r.total})`,
                selected: state.filter.rule === r.rule
            }))
        ]);
        select.addEventListener('change', () => {
            state.filter.rule = select.value ? Number(select.value) : null;
            load();
        });
        const search = el('input', {
            class: 'auth-input admin-search', type: 'search', id: 'conflictSearch', placeholder: 'Search chain, id or message',
            'aria-label': 'Search conflicts', value: state.filter.q || null, autocomplete: 'off'
        });
        let t = null;
        search.addEventListener('input', () => {
            clearTimeout(t);
            t = setTimeout(() => { state.filter.q = search.value; load(); }, 250);
        });
        return el('div', { class: 'admin-filters' }, [select, search]);
    }

    function resolvedNotice() {
        const list = state.data.resolved || [];
        if (!list.length) return null;
        const body = el('div', { class: 'admin-resolved' }, [
            el('p', {}, [
                el('strong', { text: `${list.length} decided conflict${list.length === 1 ? '' : 's'} no longer occur${list.length === 1 ? 's' : ''}` }),
                ' — fixed upstream, or the values changed (in which case it is back in Open as a new conflict).'
            ]),
            el('div', { class: 'conflict-actions' }, [
                el('button', {
                    class: 'auth-btn auth-btn-secondary', type: 'button', text: state.showResolved ? 'Hide' : 'Show',
                    onclick: () => { state.showResolved = !state.showResolved; render(); }
                }),
                el('button', {
                    class: 'auth-btn auth-btn-secondary', type: 'button', text: 'Clear them',
                    onclick: async (e) => {
                        e.currentTarget.disabled = true;
                        const r = await api('/admin/conflicts/prune-resolved', {});
                        if (r.status === 401) return signInGate('Your session ended. Sign in again to continue.');
                        state.showResolved = false;
                        load();
                    }
                })
            ])
        ]);
        if (state.showResolved) {
            body.appendChild(el('ul', { class: 'admin-history' }, list.map((d) => el('li', {}, [
                el('span', { class: 'history-when', text: when(d.at) }),
                ` ${STATE_LABEL[d.state]} by ${d.by}: `,
                el('strong', { text: `${d.chainName || 'Unnamed'}${d.chainId != null ? ` #${d.chainId}` : ''}` }),
                ` — rule ${d.rule}`,
                d.note ? el('span', { class: 'conflict-note', text: ` — “${d.note}”` }) : null
            ]))));
        }
        return body;
    }

    function historyPanel() {
        const list = el('ul', { class: 'admin-history' }, [el('li', { class: 'auth-muted', text: 'Loading…' })]);
        const details = el('details', { class: 'admin-activity' }, [el('summary', { text: 'Recent activity' }), list]);
        // Every decision re-renders the page; remember whether the panel was open, or acting on
        // a conflict would snap the history shut under the admin reading it.
        details.addEventListener('toggle', async () => {
            state.historyOpen = details.open;
            if (!details.open) return;
            const r = await api('/admin/conflicts/history?limit=50');
            if (!r.ok) { list.replaceChildren(el('li', { class: 'auth-error', text: 'Could not load the history.' })); return; }
            const entries = r.data.history;
            list.replaceChildren(...(entries.length ? entries.map((h) => el('li', {}, [
                el('span', { class: 'history-when', text: when(h.at) }),
                ` ${h.by} ${ACTION_LABEL[h.action] || h.action} `,
                el('strong', { text: `${h.chainName || 'Unnamed'}${h.chainId != null ? ` #${h.chainId}` : ''}` }),
                ` — rule ${h.rule}`,
                h.note ? el('span', { class: 'conflict-note', text: ` — “${h.note}”` }) : null
            ])) : [el('li', { class: 'auth-muted', text: 'No decisions yet.' })]));
        });
        if (state.historyOpen) details.open = true; // fires 'toggle', which reloads the entries
        return details;
    }

    function render() {
        const d = state.data;
        const shown = state.items.length;
        const empty = el('div', { class: 'feed-empty', text: d.counts.total === 0
            ? 'No cross-source conflicts right now.'
            : 'Nothing matches these filters.' });
        // Optional sections are null when absent. replaceChildren would print those as the
        // literal text "null", so they are filtered out first.
        main.replaceChildren(...[
            el('div', { class: 'admin-head' }, [
                el('h1', { class: 'auth-title', text: 'Data conflicts' }),
                el('p', { class: 'auth-lead', text: 'Places where the upstream sources disagree about a chain. Acknowledge what is real, dismiss what is noise. A dismissed conflict comes back by itself if its values change.' })
            ]),
            resolvedNotice(),
            tabs(),
            filters(),
            el('p', { class: 'admin-count', text: `Showing ${shown} of ${d.totalMatched}` }),
            shown ? el('div', { class: 'conflict-list' }, state.items.map(conflictCard)) : empty,
            shown < d.totalMatched
                ? el('p', { class: 'auth-row' }, [el('button', { class: 'auth-btn auth-btn-secondary', type: 'button', text: 'Show more', onclick: () => load({ append: true }) })])
                : null,
            historyPanel()
        ].filter(Boolean));
    }

    // ── boot ─────────────────────────────────────────────────────────────────

    document.getElementById('signOut').addEventListener('click', async () => {
        await api('/auth/logout', {});
        location.href = 'login.html';
    });

    async function boot() {
        const s = await api('/auth/session');
        if (s.status === 404) {
            return gate('Accounts are not enabled', 'This server has no accounts, so there is no admin area.', [
                el('a', { class: 'auth-btn', href: './', text: 'Go to the dashboard' })
            ]);
        }
        if (s.status === 0 || !s.ok) {
            return gate('Cannot reach the server', 'Check your connection, then try again.', [
                el('button', { class: 'auth-btn', type: 'button', text: 'Try again', onclick: () => boot() })
            ]);
        }
        if (!s.data.authenticated) return signInGate();
        state.user = s.data.user;
        document.getElementById('adminWho').textContent = state.user.email;
        nav.hidden = false;
        load();
    }

    boot();
})();
