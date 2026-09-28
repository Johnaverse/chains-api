// Chains — sign in, account and password reset.
//
// The flow mirrors Claude's: enter your email (and your password, if you set one), then
// finish with the 6-digit code or the magic link from the email.
//
// Built for the installed PWA as much as the browser tab:
//   • The code field appears at once and is the primary path. An installed app is its own
//     browser context, and on iOS a tapped link opens Safari, not the app — the code is how
//     the app finishes without leaving itself. `autocomplete="one-time-code"` lets the
//     platform offer the code from the email.
//   • Tapping the link opens this page with a `#verify=` fragment. The token is read, then
//     stripped from the address bar before anything else runs, and nothing is sent until
//     the user presses a button — mail scanners that prefetch links therefore cannot spend
//     it.
//   • When the link is followed in ANOTHER TAB OF THIS BROWSER, a BroadcastChannel message
//     tells this tab, which then finishes on its own. Returning to the tab re-checks too.
//
// No framework and no inline script: the API serves this file under `script-src 'self'`.
'use strict';

(() => {
    const SAME_ORIGIN_API =
        location.port === '3000' || location.hostname === 'chains-api.johnaverse.cc'
        || location.pathname.startsWith('/ui');
    const API_BASE = SAME_ORIGIN_API ? '' : 'https://chains-api.johnaverse.cc';

    const PASSWORD_MIN = 12;

    // Where to go after signing in, e.g. `login.html?next=admin.html`. Only a bare page name in
    // this same directory is accepted — never a path, scheme or host — so `next` cannot be
    // turned into an open redirect to someone else's site.
    const NEXT = (() => {
        const n = new URLSearchParams(location.search).get('next');
        return n && /^[a-z][a-z0-9-]*\.html$/.test(n) && n !== 'login.html' ? n : null;
    })();
    const RESEND_COOLDOWN_MS = 30_000;

    const root = document.getElementById('authView');
    const channel = 'BroadcastChannel' in window ? new BroadcastChannel('chains-auth') : null;

    // Everything sensitive lives in memory only, never in storage. `password` is kept only so
    // "resend code" can repeat a password sign-in without asking again, and it is dropped as
    // soon as the attempt ends.
    const state = {
        email: '', password: '', attemptId: null, expiresAt: null, resendAt: 0,
        linkToken: null, resetToken: null, resetAttemptId: null, user: null, busy: false
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
        try { data = await res.json(); } catch { /* 204, or no body */ }
        return { status: res.status, ok: res.ok, data };
    }

    // What to tell a person for each failure. The server's own messages are generic by
    // design (they must not reveal who has an account), so pass those through untouched.
    function failureText(r) {
        if (r.status === 0) return 'Cannot reach the server. Check your connection and try again.';
        if (r.status === 429) return 'Too many attempts. Wait a minute, then try again.';
        if (r.status === 403) return 'This page is not allowed to sign in to this server.';
        return r.data?.error || 'Something went wrong. Try again.';
    }

    function field({ id, label, type = 'text', autocomplete, hint, ...rest }) {
        const input = el('input', { id, name: id, type, autocomplete, class: 'auth-input', ...rest });
        return {
            input,
            node: el('div', { class: 'auth-field' }, [
                el('label', { for: id, class: 'auth-label', text: label }),
                input,
                hint ? el('p', { class: 'auth-hint', id: `${id}Hint`, text: hint }) : null
            ])
        };
    }

    function errorBox() {
        return el('p', { class: 'auth-error', role: 'alert', hidden: true });
    }
    function showError(box, text) {
        box.textContent = text;
        box.hidden = !text;
    }

    function button(text, props = {}) {
        return el('button', { class: `auth-btn${props.secondary ? ' auth-btn-secondary' : ''}`, type: props.type || 'button', ...props, secondary: null, text });
    }

    function linkButton(text, onclick) {
        return el('button', { class: 'auth-link', type: 'button', onclick, text });
    }

    function render(title, lead, body, { focus } = {}) {
        // Filter first: replaceChildren prints a null as the literal text "null".
        root.replaceChildren(...[
            el('h1', { class: 'auth-title', text: title }),
            lead ? el('p', { class: 'auth-lead', text: lead }) : null,
            ...[].concat(body)
        ].filter(Boolean));
        document.title = `${title} · Chains`;
        (focus || root.querySelector('input:not([type=hidden])') || root.querySelector('button'))?.focus();
    }

    // Guard every submit: a double-tap on a phone must not fire two sign-in requests.
    function submitting(form, fn) {
        return async (e) => {
            e.preventDefault();
            if (state.busy) return;
            state.busy = true;
            const btn = form.querySelector('button[type=submit]');
            if (btn) btn.disabled = true;
            try { await fn(); } finally {
                state.busy = false;
                if (btn && btn.isConnected) btn.disabled = false;
            }
        };
    }

    function timeOf(iso) {
        try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
    }

    function clearAttempt() {
        state.password = '';
        state.attemptId = null;
        state.expiresAt = null;
    }

    function signedIn(user) {
        clearAttempt();
        state.user = user;
        // Tell any other tab of this browser — the one waiting on the code screen finishes too.
        channel?.postMessage({ type: 'signed-in' });
        if (NEXT) return location.replace(NEXT);
        showDone(user);
    }

    // ── views ────────────────────────────────────────────────────────────────

    function showStart(prefill = state.email) {
        const email = field({ id: 'email', label: 'Email', type: 'email', autocomplete: 'username email', required: true, inputmode: 'email', autocapitalize: 'none', spellcheck: 'false', value: prefill || null });
        const password = field({
            id: 'password', label: 'Password', type: 'password', autocomplete: 'current-password',
            hint: 'Only if you have set one. Leave it empty to sign in with a code from your email.'
        });
        const err = errorBox();
        const form = el('form', { class: 'auth-form', novalidate: true }, [email.node, password.node, err, button('Continue', { type: 'submit' })]);

        form.addEventListener('submit', submitting(form, async () => {
            const address = email.input.value.trim();
            if (!address || !email.input.checkValidity()) return showError(err, 'Enter a valid email address.');
            showError(err, '');
            state.email = address;
            state.password = password.input.value;
            const r = await api('/auth/login/start', state.password ? { email: address, password: state.password } : { email: address });
            if (r.status !== 202) {
                state.password = '';
                return showError(err, failureText(r));
            }
            state.attemptId = r.data.attemptId;
            state.expiresAt = r.data.expiresAt;
            state.resendAt = Date.now() + RESEND_COOLDOWN_MS;
            showCode();
        }));

        render('Sign in', 'We will email you a sign-in code and link.', [
            form,
            el('p', { class: 'auth-row' }, [linkButton('Forgot your password?', () => showResetRequest(email.input.value.trim()))])
        ]);
    }

    function codeInput(id = 'code') {
        // `one-time-code` lets iOS and Android offer the code from the email; `numeric` brings
        // up the number pad. maxlength leaves room for the "123 456" people sometimes paste.
        return field({
            id, label: 'Sign-in code', type: 'text', autocomplete: 'one-time-code', inputmode: 'numeric',
            pattern: '[0-9 \\-]*', maxlength: '9', required: true, placeholder: '123456', class: 'auth-input auth-code'
        });
    }

    function showCode() {
        const code = codeInput();
        const err = errorBox();
        const form = el('form', { class: 'auth-form', novalidate: true }, [code.node, err, button('Sign in', { type: 'submit' })]);

        const submit = submitting(form, async () => {
            const typed = code.input.value.replace(/[\s-]/g, '');
            if (!/^\d{6}$/.test(typed)) return showError(err, 'Enter the 6-digit code from the email.');
            const r = await api('/auth/login/verify', { attemptId: state.attemptId, code: typed });
            if (r.ok) return signedIn(r.data.user);
            code.input.value = '';
            code.input.focus();
            showError(err, failureText(r));
        });
        form.addEventListener('submit', submit);
        // Finish the moment six digits are in — pasted, typed, or filled by the platform.
        code.input.addEventListener('input', () => {
            if (/^\d{6}$/.test(code.input.value.replace(/[\s-]/g, ''))) form.requestSubmit();
        });

        const resend = linkButton('Send a new code', null);
        const tick = () => {
            const left = Math.ceil((state.resendAt - Date.now()) / 1000);
            resend.disabled = left > 0;
            resend.textContent = left > 0 ? `Send a new code (${left}s)` : 'Send a new code';
            if (left > 0 && resend.isConnected) setTimeout(tick, 1000);
        };
        resend.addEventListener('click', async () => {
            if (resend.disabled) return;
            state.resendAt = Date.now() + RESEND_COOLDOWN_MS;
            tick();
            const r = await api('/auth/login/start', state.password ? { email: state.email, password: state.password } : { email: state.email });
            if (r.status === 202) {
                state.attemptId = r.data.attemptId;
                state.expiresAt = r.data.expiresAt;
                showError(err, '');
                code.input.value = '';
                code.input.focus();
            } else {
                showError(err, failureText(r));
            }
        });

        const expires = state.expiresAt ? ` It expires at ${timeOf(state.expiresAt)}.` : '';
        render('Check your email', `Enter the code we sent to ${state.email}.${expires}`, [
            form,
            el('p', { class: 'auth-hint auth-pwa-hint', text: 'The email also has a sign-in link. On a phone it may open in your browser rather than this app. If so, type the code here instead.' }),
            el('p', { class: 'auth-hint', text: 'No email after a minute? Check spam. If you have set a password, go back and enter it.' }),
            el('p', { class: 'auth-row' }, [resend, linkButton('Use a different email', () => { clearAttempt(); showStart(); })])
        ]);
        tick();
    }

    // A magic link arrived here. Nothing has been sent yet. The token is spent only when the
    // person presses the button, so a link scanner that fetches the page cannot sign anyone in.
    function showConfirmLink(session) {
        const err = errorBox();
        const go = button('Sign in', { type: 'submit' });
        const form = el('form', { class: 'auth-form' }, [err, go]);
        form.addEventListener('submit', submitting(form, async () => {
            const r = await api('/auth/login/link', { token: state.linkToken });
            if (r.ok) {
                state.linkToken = null;
                return signedIn(r.data.user);
            }
            showError(err, failureText(r));
            go.remove();
            form.append(button('Start again', { onclick: () => showStart() }));
        }));
        const already = session?.authenticated ? ` You are currently signed in as ${session.user.email}.` : '';
        render('Finish signing in', `This signs in this browser.${already}`, [
            form,
            // Always visible, unlike the code screen's note: this page is usually open in the
            // BROWSER the link launched, which is exactly where someone who started in the
            // installed app needs to read it.
            el('p', { class: 'auth-hint', text: 'Started in the installed app? This link signs in this browser, not the app. Type the 6-digit code from the same email into the app.' })
        ], { focus: go });
    }

    function showDone(user) {
        render('You are signed in', `Signed in as ${user.email}.`, [
            el('p', { class: 'auth-row' }, [
                el('a', { class: 'auth-btn', href: './', text: 'Go to the dashboard' }),
                el('a', { class: 'auth-btn auth-btn-secondary', href: 'admin.html', text: 'Admin' }),
                button('Account settings', { secondary: true, onclick: () => showAccount() })
            ])
        ]);
    }

    function passwordPair({ label = 'New password' } = {}) {
        const next = field({ id: 'newPassword', label, type: 'password', autocomplete: 'new-password', required: true, minlength: String(PASSWORD_MIN), hint: `At least ${PASSWORD_MIN} characters. A few unrelated words make a strong one.` });
        const again = field({ id: 'confirmPassword', label: 'Confirm password', type: 'password', autocomplete: 'new-password', required: true });
        return {
            nodes: [next.node, again.node],
            check() {
                const pw = next.input.value;
                if ([...pw].length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
                if (pw !== again.input.value) return 'The two passwords do not match.';
                return null;
            },
            value: () => next.input.value
        };
    }

    function showAccount() {
        const user = state.user;
        const err = errorBox();
        const ok = el('p', { class: 'auth-ok', role: 'status', hidden: true });
        const current = user.hasPassword
            ? field({ id: 'currentPassword', label: 'Current password', type: 'password', autocomplete: 'current-password', required: true })
            : null;
        const pair = passwordPair();
        const form = el('form', { class: 'auth-form', novalidate: true }, [
            // A hidden username field lets password managers attach the new password to the
            // right account.
            el('input', { type: 'email', autocomplete: 'username', value: user.email, hidden: true, readonly: true, tabindex: '-1' }),
            current?.node, ...pair.nodes, err, ok,
            button(user.hasPassword ? 'Change password' : 'Add password', { type: 'submit' })
        ]);
        form.addEventListener('submit', submitting(form, async () => {
            ok.hidden = true;
            const problem = pair.check();
            if (problem) return showError(err, problem);
            showError(err, '');
            const body = { newPassword: pair.value() };
            if (current) body.currentPassword = current.input.value;
            const r = await api('/auth/password', body);
            if (!r.ok) return showError(err, failureText(r));
            state.user = r.data.user;
            showAccount();
            const saved = root.querySelector('.auth-ok');
            saved.textContent = 'Password saved. Every other device was signed out.';
            saved.hidden = false;
        }));

        const explain = user.hasPassword
            ? 'Signing in takes your password and the emailed code.'
            : 'Adding a password adds a second step: after this, signing in takes your password and the emailed code.';

        render('Account', `Signed in as ${user.email}.`, [
            el('h2', { class: 'auth-subtitle', text: 'Password' }),
            el('p', { class: 'auth-hint', text: explain }),
            form,
            el('p', { class: 'auth-row' }, [
                linkButton('Sign out', async () => {
                    await api('/auth/logout', {});
                    state.user = null;
                    channel?.postMessage({ type: 'signed-out' });
                    showStart();
                })
            ])
        ]);
    }

    function showResetRequest(prefill = '') {
        const email = field({ id: 'email', label: 'Email', type: 'email', autocomplete: 'username email', required: true, inputmode: 'email', autocapitalize: 'none', value: prefill || null });
        const err = errorBox();
        const form = el('form', { class: 'auth-form', novalidate: true }, [email.node, err, button('Email me a reset code', { type: 'submit' })]);
        form.addEventListener('submit', submitting(form, async () => {
            const address = email.input.value.trim();
            if (!address || !email.input.checkValidity()) return showError(err, 'Enter a valid email address.');
            const r = await api('/auth/password/reset/start', { email: address });
            if (r.status !== 202) return showError(err, failureText(r));
            state.email = address;
            state.resetAttemptId = r.data.attemptId;
            showResetWithCode();
        }));
        render('Reset your password', 'We will email you a code and a link to choose a new password.', [
            form,
            el('p', { class: 'auth-row' }, [linkButton('Back to sign in', () => showStart())])
        ]);
    }

    function showResetWithCode() {
        const code = codeInput('resetCode');
        code.node.querySelector('label').textContent = 'Reset code';
        const pair = passwordPair();
        const err = errorBox();
        const form = el('form', { class: 'auth-form', novalidate: true }, [
            el('input', { type: 'email', autocomplete: 'username', value: state.email, hidden: true, readonly: true, tabindex: '-1' }),
            code.node, ...pair.nodes, err, button('Set new password', { type: 'submit' })
        ]);
        form.addEventListener('submit', submitting(form, async () => {
            const typed = code.input.value.replace(/[\s-]/g, '');
            if (!/^\d{6}$/.test(typed)) return showError(err, 'Enter the 6-digit code from the email.');
            const problem = pair.check();
            if (problem) return showError(err, problem);
            const r = await api('/auth/password/reset/complete', { attemptId: state.resetAttemptId, code: typed, newPassword: pair.value() });
            if (r.ok) { state.resetAttemptId = null; return signedIn(r.data.user); }
            showError(err, failureText(r));
        }));
        render('Check your email', `If ${state.email} has an account, a reset code is on its way.`, [
            form,
            el('p', { class: 'auth-row' }, [linkButton('Back to sign in', () => showStart())])
        ]);
    }

    function showResetWithLink() {
        const pair = passwordPair();
        const err = errorBox();
        const form = el('form', { class: 'auth-form', novalidate: true }, [...pair.nodes, err, button('Set new password', { type: 'submit' })]);
        form.addEventListener('submit', submitting(form, async () => {
            const problem = pair.check();
            if (problem) return showError(err, problem);
            const r = await api('/auth/password/reset/complete', { token: state.resetToken, newPassword: pair.value() });
            if (r.ok) { state.resetToken = null; return signedIn(r.data.user); }
            showError(err, failureText(r));
        }));
        render('Choose a new password', 'Every device signed in to your account will be signed out.', [form]);
    }

    function showUnavailable() {
        render('Sign-in is not enabled', 'This server does not have accounts turned on.', [
            el('p', { class: 'auth-row' }, [el('a', { class: 'auth-btn', href: './', text: 'Go to the dashboard' })])
        ]);
    }

    function showOffline() {
        render('Cannot reach the server', 'Check your connection, then try again.', [
            el('p', { class: 'auth-row' }, [button('Try again', { onclick: () => boot() })])
        ]);
    }

    // ── cross-tab finish ─────────────────────────────────────────────────────

    async function checkSignedInElsewhere() {
        if (!state.attemptId) return;
        const s = await api('/auth/session');
        if (s.data?.authenticated) signedIn(s.data.user);
    }
    channel?.addEventListener('message', (e) => {
        if (e.data?.type === 'signed-in') checkSignedInElsewhere();
    });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') checkSignedInElsewhere();
    });

    // ── boot ─────────────────────────────────────────────────────────────────

    // Read the token and remove it from the address bar before anything else, so it is not
    // left in history, a screenshot, or a copied URL.
    function takeFragmentToken() {
        const m = /^#(verify|reset)=([A-Za-z0-9_-]{16,128})$/.exec(location.hash);
        if (location.hash) history.replaceState(null, '', location.pathname + location.search);
        return m ? { kind: m[1], token: m[2] } : null;
    }

    const fragment = takeFragmentToken();

    // A link can also arrive WITHOUT a page load. When this page is already open — the
    // installed app sitting on "Check your email", with the manifest's navigate-existing
    // launch mode, or a browser that reuses the tab — following a link to this same URL with a
    // new #verify= is a same-document fragment navigation. The page does not reload, so the
    // boot-time read above never sees it; without this listener the user would be stuck.
    window.addEventListener('hashchange', async () => {
        const f = takeFragmentToken();
        if (!f) return;
        if (f.kind === 'verify') {
            state.linkToken = f.token;
            const s = await api('/auth/session');
            return showConfirmLink(s.data);
        }
        state.resetToken = f.token;
        showResetWithLink();
    });

    async function boot() {
        const s = await api('/auth/session');
        if (s.status === 404) return showUnavailable();
        if (s.status === 0 || !s.ok) return showOffline();
        if (fragment?.kind === 'verify') { state.linkToken = fragment.token; return showConfirmLink(s.data); }
        if (fragment?.kind === 'reset') { state.resetToken = fragment.token; return showResetWithLink(); }
        if (s.data.authenticated) {
            if (NEXT) return location.replace(NEXT);
            state.user = s.data.user;
            return showAccount();
        }
        showStart();
    }

    boot();
})();
