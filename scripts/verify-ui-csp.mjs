// Serve public/ under the EXACT Content-Security-Policy the API sends for /ui, load every
// view, and fail on anything the policy silently breaks.
//
// Why this exists: the same three files ship two ways. GitHub Pages sends no CSP; the API
// serves them at /ui under `script-src 'self'` / `style-src 'self'` with no 'unsafe-inline'
// (src/http/app.js). A refused inline style produces NO console error and NO exception — the
// element simply never takes the style — so a bug of this class looks perfect in local
// development and on Pages, and is only visible on the deployment most likely to be used for
// debugging. Three real defects were found this way in one sitting:
//
//   • el() assigned styles with setAttribute, so every JS-positioned element (timeline pins,
//     urgency blobs, axis ticks, availability bars) would have collapsed to the left edge.
//   • 20 inline style attributes in index.html, two of which coloured a legend dot that
//     therefore rendered invisible.
//   • The anti-flash theme bootstrap was an inline <script>, refused outright — so the flash
//     it exists to prevent was happening on /ui the whole time.
//
// It also sweeps every view at phone width for horizontal overflow, which is how a
// specificity bug in the stacked-table CSS was caught (a long cell refused to wrap and
// pushed the document 400px wider than the viewport).
//
// Prerequisites: chromium at /usr/bin/chromium-browser. No dependencies — Node's built-in
// WebSocket speaks CDP, and the static server is node:http. Live network data is NOT
// required: the checks are about layout and policy, not content.
//
//   node scripts/verify-ui-csp.mjs            # exits non-zero on any failure
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = Number(process.env.PORT || 8793);
const CDP_PORT = Number(process.env.CDP_PORT || 9336);
const CHROME = process.env.CHROME || '/usr/bin/chromium-browser';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Must mirror src/http/app.js. If that policy is relaxed or tightened, this string moves too
// — the point of the test is that the two agree.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self' https://chains-api.johnaverse.cc"
    + ' https://chains-status-news.johnaverse.cc wss://chains-status-news.johnaverse.cc'
    + ' https://chains-forum-news.johnaverse.cc wss://chains-forum-news.johnaverse.cc'
    + ' https://chains-news.johnaverse.cc wss://chains-news.johnaverse.cc'
].join('; ');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, rel === '/' ? '/index.html' : rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    'content-security-policy': CSP
  });
  fs.createReadStream(file).pipe(res);
});
// Walk forward if the port is taken — an earlier interrupted run can leave one bound, and a
// bare EADDRINUSE stack trace reads like the dashboard is broken when nothing is.
const port = await new Promise((resolve, reject) => {
  let candidate = PORT;
  const attempt = () => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE' && candidate < PORT + 20) { candidate += 1; attempt(); }
      else reject(err);
    });
    server.listen(candidate, () => resolve(candidate));
  };
  attempt();
});

const failures = [];
const note = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--no-sandbox', '--disable-gpu',
  '--hide-scrollbars', '--window-size=1400,1000', `http://127.0.0.1:${port}/index.html`
], { stdio: 'ignore' });

let sock;
try {
  let targets = [];
  for (let i = 0; i < 40 && targets.length === 0; i++) {
    await wait(500);
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
      targets = (await res.json()).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch { /* not up yet */ }
  }
  if (!targets.length) throw new Error('no CDP page target');

  // Node's built-in WebSocket is the WHATWG API (addEventListener), not ws's EventEmitter.
  sock = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    sock.addEventListener('open', res, { once: true });
    sock.addEventListener('error', rej, { once: true });
  });

  let msgId = 0;
  const pending = new Map();
  const violations = [];
  let currentView = 'boot';
  sock.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    // Every refused inline style/script arrives here and nowhere else — this is the only
    // signal the browser gives, and it never reaches window.onerror.
    if (msg.method === 'Log.entryAdded') {
      const e = msg.params?.entry || {};
      // Attribute by the view that was active when it fired. The log entry's TEXT never names
      // a source file, so matching on the library name there silently matches nothing — an
      // earlier version of this script filtered that way and cheerfully reported every
      // vendored violation as ours.
      if (/Content Security Policy/i.test(e.text || '')) {
        violations.push({ view: currentView, url: e.url || '', text: (e.text || '').slice(0, 120) });
      }
    }
  });
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++msgId;
    pending.set(id, res);
    sock.send(JSON.stringify({ id, method, params }));
  });

  await send('Runtime.enable');
  await send('Log.enable');
  const evaluate = async (expression) => {
    const out = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (out.result?.exceptionDetails) throw new Error(JSON.stringify(out.result.exceptionDetails));
    return out.result?.result?.value;
  };

  for (let i = 0; i < 40; i++) {
    if (await evaluate('typeof switchView === "function" && Array.isArray(VIEWS)')) break;
    await wait(500);
  }
  await wait(3000);

  console.log(`\nCSP: ${CSP}\n`);

  // 1. The theme bootstrap must survive the policy — it is a file precisely so it can.
  const themed = await evaluate(`(() => {
    localStorage.setItem('chains:theme', 'light');
    return true;
  })()`);
  await send('Page.enable');
  await evaluate('location.reload()');
  await wait(4000);
  const themeApplied = await evaluate(`document.documentElement.getAttribute('data-theme')`);
  note(themed && themeApplied === 'light', 'theme bootstrap survives script-src',
    `data-theme=${themeApplied}`);
  await evaluate(`localStorage.removeItem('chains:theme')`);

  // 2. Nothing in the markup may rely on an inline style attribute: CSP drops those, and a
  //    dropped one is invisible. Styles set through the CSSOM are fine and expected.
  const inlineInMarkup = await evaluate(`(async () => {
    const html = await (await fetch('index.html')).text();
    return (html.match(/<[^>]+\\sstyle=/g) || []).length;
  })()`);
  note(inlineInMarkup === 0, 'no inline style attributes in index.html',
    `${inlineInMarkup} found`);

  // 3. Every view renders, and nothing on it pushes the document wider than the viewport.
  const views = await evaluate('VIEWS.slice()');
  for (const width of [1440, 390]) {
    await send('Emulation.setDeviceMetricsOverride', {
      width, height: 900, deviceScaleFactor: 1, mobile: width < 760
    });
    for (const view of views) {
      currentView = view;
      await evaluate(`switchView(${JSON.stringify(view)})`);
      // Views that fetch on first entry need longer than a fixed guess.
      let r = null;
      for (let i = 0; i < 12; i++) {
        await wait(700);
        r = await evaluate(`(() => {
          const sec = document.querySelector('.view.active');
          return {
            nodes: sec ? sec.querySelectorAll('*').length : 0,
            docW: document.documentElement.scrollWidth,
            winW: window.innerWidth,
            widest: (() => {
              let worst = 0, what = '';
              for (const n of (sec ? sec.querySelectorAll('*') : [])) {
                const b = n.getBoundingClientRect();
                if (b.right > worst) { worst = b.right; what = n.tagName + '.' + (n.className || '').toString().slice(0, 30); }
              }
              return { right: Math.round(worst), what };
            })()
          };
        })()`);
        if (r.nodes > 60) break;
      }
      const overflow = r.docW > r.winW + 1;
      note(!overflow, `${String(width).padEnd(4)} ${view.padEnd(10)} fits the viewport`,
        overflow ? `document ${r.docW}px > viewport ${r.winW}px, widest ${r.widest.what} @ ${r.widest.right}px` : `${r.nodes} nodes`);
    }
  }

  // 4. Refused styles and scripts. The vendored 3d-force-graph sets inline styles from inside
  //    the minified library, which this policy refuses; the graph still renders correctly
  //    (verified separately), and fixing it would mean patching a dependency. Those are
  //    tolerated BY VIEW. A violation from any other view is our code and fails the run.
  const vendored = violations.filter((v) => v.view === 'graph');
  const ours = violations.filter((v) => v.view !== 'graph');
  console.log(`\n  ${violations.length} CSP violation(s): ${vendored.length} on the graph view `
    + '(vendored 3d-force-graph, known and tolerated).');
  for (const v of ours) console.log(`    [${v.view}] ${v.url} ${v.text}`);
  note(ours.length === 0, 'no CSP violations outside the vendored graph library',
    ours.length ? `${ours.length} from ${[...new Set(ours.map((v) => v.view))].join(', ')}` : '');
} finally {
  try { sock?.close(); } catch { /* already gone */ }
  chrome.kill();
  server.close();
}

console.log(failures.length ? `\nFAILED: ${failures.length} check(s)\n` : '\nAll checks passed.\n');
process.exit(failures.length ? 1 : 0);
