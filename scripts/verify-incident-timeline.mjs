// Render the dashboard in headless chromium against LIVE data and read the incident
// timelines back out of the DOM.
//
// Why a browser and not a unit test: public/app.js is a classic script, so its
// functions cannot be imported, and the page ships `style-src 'self'` — a style
// ATTRIBUTE is dropped with no error, so per-element animation and colour have to be
// asserted as COMPUTED values on a laid-out element. Two defects found this way:
// maintenance dots rendering grey because the palette keyed on the feed's raw enum
// instead of the label, and a 35-second outage displayed as "1m".
//
// Prerequisites: chromium at /usr/bin/chromium-browser, and the page served locally:
//   (cd public && python3 -m http.server 8793) &
//   node scripts/verify-incident-timeline.mjs
// It fetches LIVE production data over the network, so output varies with what is
// actually happening. No dependencies: Node's built-in WebSocket speaks CDP — which needs
// Node >= 22, checked below, even though the project itself runs on >= 20.
import { spawn } from 'node:child_process';


const PORT = process.env.PORT || '8793';
const CDP_PORT = process.env.CDP_PORT || '9335';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// package.json allows Node >=20, but the global WHATWG WebSocket this uses to speak CDP only
// became available unflagged in Node 22. Say so plainly rather than failing later with a bare
// ReferenceError that reads like the dashboard is broken. Checked BEFORE chromium is spawned,
// so exiting here does not leave an orphaned browser behind. (Adding `ws` would put a
// dependency in scripts that deliberately have none.)
if (typeof WebSocket === 'undefined') {
  console.error(`This script drives chromium over CDP using Node's global WebSocket, which is
unavailable on ${process.version} (needs Node >= 22). The rest of the project runs on Node >= 20.`);
  process.exit(2);
}

const chrome = spawn('/usr/bin/chromium-browser', [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--no-sandbox',
  '--disable-gpu', '--hide-scrollbars', '--window-size=1400,2000',
  `http://127.0.0.1:${PORT}/?view=incidents`
], { stdio: 'ignore' });

let ws, sock;
try {
  // Give chromium a moment, then find the page target.
  let targets = [];
  for (let i = 0; i < 30 && targets.length === 0; i++) {
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
  sock.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++msgId;
    pending.set(id, res);
    sock.send(JSON.stringify({ id, method, params }));
  });

  await send('Runtime.enable');
  const evaluate = async (expression) => {
    const out = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (out.result?.exceptionDetails) throw new Error(JSON.stringify(out.result.exceptionDetails));
    return out.result?.result?.value;
  };

  // The incident list fills from a live fetch plus a WS replay; poll for it rather
  // than guessing a fixed delay.
  let cards = 0;
  for (let i = 0; i < 40 && cards === 0; i++) {
    await wait(1000);
    cards = await evaluate(`document.querySelectorAll('.incident-card').length`);
  }

  const report = await evaluate(`(() => {
    const out = { cards: document.querySelectorAll('.incident-card').length, timelines: 0, dotColours: {}, greyDots: 0, samples: [], secondsSeen: [] };
    const muted = getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim();
    for (const tl of document.querySelectorAll('.incident-timeline')) {
      out.timelines++;
      for (const step of tl.querySelectorAll('.tl-step')) {
        const dot = step.querySelector('.tl-dot');
        const bg = getComputedStyle(dot).backgroundColor;
        const cls = [...dot.classList].find(c => c.startsWith('st-')) || 'none';
        out.dotColours[cls + ' -> ' + bg] = (out.dotColours[cls + ' -> ' + bg] || 0) + 1;
        if (cls === 'none') out.greyDots++;
        const gap = step.querySelector('.tl-gap')?.textContent || '';
        if (/\\ds$/.test(gap)) out.secondsSeen.push(gap);
      }
      if (out.samples.length < 4) {
        out.samples.push({
          title: tl.closest('.incident-card').querySelector('.incident-title')?.textContent?.trim().slice(0, 44),
          rows: [...tl.querySelectorAll('.tl-step')].map(s => [
            s.querySelector('.tl-time')?.textContent, s.querySelector('.tl-label')?.textContent, s.querySelector('.tl-gap')?.textContent || ''
          ].join(' | '))
        });
      }
    }
    out.mutedToken = muted;
    return out;
  })()`);
  console.log(JSON.stringify(report, null, 1));
} finally {
  try { sock?.close(); } catch { /* ignore */ }
  chrome.kill('SIGTERM');
}
