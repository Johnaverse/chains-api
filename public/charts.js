// ─────────────────────────────────────────────────────────────────────────
// charts.js — dependency-free SVG chart primitives for the Chains dashboard.
//
// Deliberate constraints, and why:
//   • No charting library. The dashboard has no build step and ships from
//     GitHub Pages; a 200 KB vendor bundle for five chart forms isn't worth it.
//   • Every chart carries axes/ticks, hairline gridlines, a hover tooltip and
//     a table-view twin, so no value is reachable only by hovering.
//   • Colors come from CSS custom properties, never from literals here, so
//     light/dark theming happens in one place and the validated palette
//     can't drift between CSS and JS.
//   • NO time-series forms. This API stores only current snapshots (see
//     README of the redesign): the one exception is event feeds, which get
//     an explicit day-bucket histogram of observed events — a count of
//     things that happened, not a trend line through a persisted metric.
//
// Public surface: globalThis.Viz
// ─────────────────────────────────────────────────────────────────────────

(function () {
    'use strict';

    const SVG_NS = 'http://www.w3.org/2000/svg';

    // ── tiny DOM/SVG builders ────────────────────────────────────────────
    function svgEl(tag, attrs = {}, children = []) {
        const n = document.createElementNS(SVG_NS, tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (v === null || v === undefined) continue;
            if (k === 'text') n.textContent = v;
            else if (k === 'class') n.setAttribute('class', v);
            else n.setAttribute(k, v);
        }
        for (const c of [].concat(children)) if (c) n.appendChild(c);
        return n;
    }
    function h(tag, props = {}, children = []) {
        const n = document.createElement(tag);
        for (const [k, v] of Object.entries(props)) {
            if (v === null || v === undefined) continue;
            if (k === 'class') n.className = v;
            else if (k === 'text') n.textContent = v;
            else if (k === 'html') n.innerHTML = v;
            else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
            else n.setAttribute(k, v);
        }
        for (const c of [].concat(children)) {
            if (c == null) continue;
            n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
        }
        return n;
    }

    // ── formatting ───────────────────────────────────────────────────────
    function fmtUsd(n) {
        if (n == null || !Number.isFinite(n)) return '—';
        const a = Math.abs(n);
        if (a >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
        if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
        if (a >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
        if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
        return `$${n.toFixed(0)}`;
    }
    function fmtNum(n) {
        if (n == null || !Number.isFinite(n)) return '—';
        return n.toLocaleString();
    }
    function fmtPct(n, dp = 1) {
        if (n == null || !Number.isFinite(n)) return '—';
        return `${n.toFixed(dp)}%`;
    }
    // Compact axis ticks: 0 / 5B / 10B rather than 0 / 5,000,000,000.
    function fmtAxisUsd(n) {
        if (n === 0) return '0';
        const a = Math.abs(n);
        if (a >= 1e12) return `$${trimZero(n / 1e12)}T`;
        if (a >= 1e9) return `$${trimZero(n / 1e9)}B`;
        if (a >= 1e6) return `$${trimZero(n / 1e6)}M`;
        if (a >= 1e3) return `$${trimZero(n / 1e3)}K`;
        return `$${n}`;
    }
    function trimZero(x) {
        const s = x.toFixed(1);
        return s.endsWith('.0') ? s.slice(0, -2) : s;
    }
    function fmtAxisNum(n) {
        if (n === 0) return '0';
        if (Math.abs(n) >= 1e6) return `${trimZero(n / 1e6)}M`;
        if (Math.abs(n) >= 1e3) return `${trimZero(n / 1e3)}K`;
        return String(n);
    }

    // "Nice" axis maximum + tick step, so ticks land on round numbers.
    function niceScale(max, targetTicks = 4) {
        if (!Number.isFinite(max) || max <= 0) return { max: 1, step: 1, ticks: [0, 1] };
        const raw = max / targetTicks;
        const mag = 10 ** Math.floor(Math.log10(raw));
        const norm = raw / mag;
        const stepNorm = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
        const step = stepNorm * mag;
        const top = Math.ceil(max / step) * step;
        const ticks = [];
        for (let v = 0; v <= top + step / 1000; v += step) ticks.push(v);
        return { max: top, step, ticks };
    }

    // ── theme-aware color reads ──────────────────────────────────────────
    // Read once per render from the live computed style so a theme flip and a
    // re-render always agree; never cache across renders.
    function cssVar(name) {
        return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    }
    function sequentialRamp() {
        return [1, 2, 3, 4, 5, 6, 7].map(i => cssVar(`--seq-${i}`)).filter(Boolean);
    }
    // Mix two hex colors — used to build diverging arms and heat steps as real
    // colors (monotone toward the surface) instead of stacking alpha.
    function mix(a, b, t) {
        const pa = hexToRgb(a), pb = hexToRgb(b);
        if (!pa || !pb) return a;
        const r = Math.round(pa[0] + (pb[0] - pa[0]) * t);
        const g = Math.round(pa[1] + (pb[1] - pa[1]) * t);
        const bl = Math.round(pa[2] + (pb[2] - pa[2]) * t);
        return `rgb(${r},${g},${bl})`;
    }
    function hexToRgb(hex) {
        const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex).trim());
        if (!m) return null;
        return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
    }

    // ── shared tooltip ───────────────────────────────────────────────────
    let tip = null;
    function tooltipEl() {
        if (!tip) {
            tip = h('div', { id: 'vizTooltip', role: 'status', 'aria-live': 'polite' });
            document.body.appendChild(tip);
        }
        return tip;
    }
    // rows: [{label, value, colorVar?}] — value leads, label follows.
    function showTip(evt, { title, value, rows = [], note } = {}) {
        const t = tooltipEl();
        t.textContent = '';
        if (value != null) t.appendChild(h('div', { class: 'tt-value', text: String(value) }));
        if (title) t.appendChild(h('div', { class: 'tt-label', text: title }));
        for (const r of rows) {
            const row = h('div', { class: 'tt-row' });
            if (r.color) {
                const key = h('span', { class: 'tt-key' });
                key.style.background = r.color;
                row.appendChild(key);
            }
            row.appendChild(h('span', { text: `${r.label}: ` }));
            row.appendChild(h('strong', { text: String(r.value) }));
            t.appendChild(row);
        }
        if (note) t.appendChild(h('div', { class: 'tt-note', text: note }));
        t.classList.add('is-visible');
        moveTip(evt);
    }
    function moveTip(evt) {
        const t = tooltipEl();
        // Anchor from a pointer event or from an element's box (keyboard focus).
        let x, y;
        if (evt && typeof evt.clientX === 'number' && evt.clientX !== 0) { x = evt.clientX; y = evt.clientY; }
        else if (evt?.target?.getBoundingClientRect) {
            const r = evt.target.getBoundingClientRect();
            x = r.left + r.width / 2; y = r.top;
        } else return;
        const r = t.getBoundingClientRect();
        const pad = 12;
        let left = x + pad, top = y - r.height - pad;
        if (left + r.width > window.innerWidth - 8) left = x - r.width - pad;
        if (left < 8) left = 8;
        if (top < 8) top = y + pad;
        t.style.left = `${left}px`;
        t.style.top = `${top}px`;
    }
    function hideTip() { if (tip) tip.classList.remove('is-visible'); }
    window.addEventListener('scroll', hideTip, { passive: true });

    // Attach hover + keyboard-focus tooltip to a mark, with a hit target that
    // is bigger than the painted mark.
    function bindTip(node, spec, { focusable = true } = {}) {
        node.addEventListener('pointerenter', e => showTip(e, spec));
        node.addEventListener('pointermove', moveTip);
        node.addEventListener('pointerleave', hideTip);
        if (focusable) {
            node.setAttribute('tabindex', '0');
            node.addEventListener('focus', e => showTip(e, spec));
            node.addEventListener('blur', hideTip);
        }
    }

    // ── table-view twin ──────────────────────────────────────────────────
    // Renders the same data as an accessible table and wires a toggle button.
    // The table is the WCAG-clean equivalent of every chart on the page.
    function tableTwin({ caption, columns, rows }) {
        const thead = h('thead', {}, [
            h('tr', {}, columns.map(c => h('th', { class: c.num ? 'num' : null, scope: 'col', text: c.label })))
        ]);
        const tbody = h('tbody', {}, rows.map(r =>
            h('tr', {}, columns.map(c => h('td', { class: c.num ? 'num' : null, text: String(r[c.key] ?? '—') })))
        ));
        const table = h('table', { class: 'chart-table hidden' }, [
            caption ? h('caption', { text: caption }) : null, thead, tbody
        ]);
        return table;
    }
    function attachTableToggle(container, table, host) {
        const btn = h('button', {
            class: 'chart-table-toggle', type: 'button', 'aria-pressed': 'false',
            text: 'Table', title: 'Show the underlying values as a table'
        });
        btn.addEventListener('click', () => {
            const on = btn.getAttribute('aria-pressed') === 'true';
            btn.setAttribute('aria-pressed', String(!on));
            table.classList.toggle('hidden', on);
        });
        (host || container).appendChild(btn);
        return btn;
    }

    // ═════════════════════════════════════════════════════════════════════
    // Horizontal bar chart — magnitude, low→high, one series, one hue.
    //
    // Nominal categories (project names, stacks, DA layers) all take the SAME
    // hue: coloring each bar by its own value would re-encode bar length as
    // hue and burn the identity channel on nothing.
    //
    // opts: { data:[{label,value,id?,sub?}], valueFmt, axisFmt, unit,
    //         onSelect?, barFill?, tableCaption?, maxBars? }
    // ═════════════════════════════════════════════════════════════════════
    function barChart(container, opts) {
        const {
            data = [], valueFmt = fmtNum, axisFmt = fmtAxisNum, unit = '',
            onSelect = null, barFill = 'fill-seq', tableCaption = '',
            labelWidth = 168, barThickness = 14, rowGap = 10
        } = opts;

        container.textContent = '';
        if (!data.length) {
            container.appendChild(h('div', { class: 'chart-empty', text: 'No data available.' }));
            return;
        }

        const W = Math.max(container.clientWidth || 760, 240);
        // Narrow screens: a 168px category gutter on a ~320px canvas leaves the
        // bars ~90px of plot, which makes every bar look the same length. Below
        // the threshold the label moves ABOVE its bar so the bar gets the full
        // width, and the value sits on the same line as the label.
        const narrow = W < 460;
        const PAD_R = narrow ? 8 : 66;   // room for the value label at the bar tip
        const AXIS_H = 22;               // x-axis band — inside the SVG, never clipped
        const LABEL_H = 16;              // the stacked label line, narrow mode only
        const gutter = narrow ? 0 : labelWidth;
        const rowH = barThickness + rowGap + (narrow ? LABEL_H : 0);
        const plotH = data.length * rowH;
        const H = plotH + AXIS_H;
        const plotW = Math.max(W - gutter - PAD_R, 60);

        const maxVal = Math.max(...data.map(d => d.value || 0));
        const scale = niceScale(maxVal, 4);
        const x = v => (v / scale.max) * plotW;

        const svg = svgEl('svg', {
            class: 'chart-svg', viewBox: `0 0 ${W} ${H}`, height: H,
            role: 'img', 'aria-label': `${tableCaption || 'Bar chart'} — ${data.length} categories`
        });

        // gridlines + x ticks (solid hairlines, one step off the surface)
        const grid = svgEl('g', { class: 'chart-grid' });
        const axis = svgEl('g', { class: 'chart-axis' });
        for (const t of scale.ticks) {
            const gx = gutter + x(t);
            grid.appendChild(svgEl('line', { x1: gx, y1: 0, x2: gx, y2: plotH }));
            axis.appendChild(svgEl('text', {
                x: gx, y: plotH + 14,
                'text-anchor': t === 0 ? 'start' : t === scale.ticks[scale.ticks.length - 1] ? 'end' : 'middle',
                class: 'chart-tick', text: axisFmt(t)
            }));
        }
        // baseline
        axis.appendChild(svgEl('line', { x1: gutter, y1: 0, x2: gutter, y2: plotH }));
        svg.appendChild(grid);
        svg.appendChild(axis);

        const marks = svgEl('g', { class: 'chart-marks' });
        data.forEach((d, i) => {
            const rowTop = i * rowH;
            const y = rowTop + rowGap / 2 + (narrow ? LABEL_H : 0);
            const w = Math.max(x(d.value || 0), 1);
            const clickable = onSelect && d.id != null;

            const row = svgEl('g', { class: `chart-row${clickable ? ' is-clickable' : ''}` });

            // Full-width transparent hit area: the target is bigger than the mark.
            const hit = svgEl('rect', {
                class: 'chart-hit', x: 0, y: rowTop, width: W, height: rowH
            });
            row.appendChild(hit);

            // Category label, ink-toned (never the series color).
            if (narrow) {
                // Above the bar, with the value right-aligned on the same line.
                row.appendChild(svgEl('text', {
                    x: 0, y: rowTop + 11, 'text-anchor': 'start',
                    class: 'chart-cat-label', text: truncate(d.label, 30)
                }));
                row.appendChild(svgEl('text', {
                    x: W, y: rowTop + 11, 'text-anchor': 'end',
                    class: 'chart-value-label', text: valueFmt(d.value)
                }));
            } else {
                row.appendChild(svgEl('text', {
                    x: labelWidth - 10, y: y + barThickness / 2 + 4, 'text-anchor': 'end',
                    class: 'chart-cat-label', text: truncate(d.label, 26)
                }));
            }

            row.appendChild(svgEl('path', {
                class: `chart-bar ${barFill}`,
                d: roundedBarPath(gutter, y, w, barThickness, 4)
            }));

            // Direct value label at the tip — selective by construction (one
            // per bar, and the axis carries the rest). In narrow mode it has
            // already been placed on the label line.
            if (!narrow) {
                row.appendChild(svgEl('text', {
                    x: gutter + w + 8, y: y + barThickness / 2 + 4,
                    class: 'chart-value-label', text: valueFmt(d.value)
                }));
            }

            const spec = {
                value: valueFmt(d.value), title: d.label,
                rows: d.sub ? [{ label: d.sub.label, value: d.sub.value }] : [],
                note: unit || undefined
            };
            bindTip(hit, spec);
            if (clickable) {
                hit.setAttribute('role', 'button');
                hit.setAttribute('aria-label', `${d.label}: ${valueFmt(d.value)}`);
                hit.style.cursor = 'pointer';
                hit.addEventListener('click', () => onSelect(d.id));
                hit.addEventListener('keydown', e => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(d.id); }
                });
            }
            marks.appendChild(row);
        });
        svg.appendChild(marks);

        const chart = h('div', { class: 'chart' }, [svg]);
        container.appendChild(chart);

        const table = tableTwin({
            caption: tableCaption,
            columns: [{ key: 'label', label: 'Category' }, { key: 'value', label: unit || 'Value', num: true }],
            rows: data.map(d => ({ label: d.label, value: valueFmt(d.value) }))
        });
        container.appendChild(table);
        return { table };
    }

    // A bar whose data-end is 4px-rounded and whose baseline end is square.
    function roundedBarPath(x, y, w, hgt, r) {
        const rr = Math.min(r, w, hgt / 2);
        if (w <= rr) return `M${x},${y} h${w} v${hgt} h${-w} Z`;
        return `M${x},${y} h${w - rr} a${rr},${rr} 0 0 1 ${rr},${rr} v${hgt - 2 * rr} a${rr},${rr} 0 0 1 ${-rr},${rr} h${-(w - rr)} Z`;
    }
    function truncate(s, n) {
        s = String(s ?? '');
        return s.length > n ? `${s.slice(0, n - 1)}…` : s;
    }

    // ═════════════════════════════════════════════════════════════════════
    // Composition bar — one horizontal stacked bar showing part-to-whole.
    // Segments are separated by a 2px surface gap, never by a stroke.
    // Categorical hues assigned in fixed slot order, capped at 4 + Other.
    // opts: { parts:[{label,value}], total?, valueFmt, tableCaption }
    // ═════════════════════════════════════════════════════════════════════
    function compositionBar(container, opts) {
        const { parts = [], valueFmt = fmtUsd, tableCaption = '', maxSlots = 4 } = opts;
        container.textContent = '';

        const clean = parts.filter(p => Number.isFinite(p.value) && p.value > 0)
            .sort((a, b) => b.value - a.value);
        if (!clean.length) {
            container.appendChild(h('div', { class: 'chart-empty', text: 'No data available.' }));
            return;
        }
        // Fold the tail into "Other" rather than generating a 5th+ hue.
        let shown = clean;
        if (clean.length > maxSlots + 1) {
            const head = clean.slice(0, maxSlots);
            const tail = clean.slice(maxSlots);
            shown = head.concat([{
                label: `Other (${tail.length})`,
                value: tail.reduce((s, p) => s + p.value, 0),
                isOther: true
            }]);
        }
        const total = shown.reduce((s, p) => s + p.value, 0);
        const slotVar = (i, isOther) => isOther ? '--cat-0' : `--cat-${(i % 3) + 1}`;

        const BAR_H = 26, GAP = 2;
        const W = Math.max(container.clientWidth || 760, 240);
        const svg = svgEl('svg', {
            class: 'chart-svg', viewBox: `0 0 ${W} ${BAR_H}`, height: BAR_H,
            role: 'img', 'aria-label': `${tableCaption || 'Composition'} — ${shown.length} segments`
        });
        const marks = svgEl('g', { class: 'chart-marks' });

        let cursor = 0;
        shown.forEach((p, i) => {
            const frac = p.value / total;
            const w = Math.max(frac * (W - GAP * (shown.length - 1)), 2);
            const color = cssVar(slotVar(i, p.isOther));
            const rect = svgEl('rect', {
                x: cursor, y: 0, width: w, height: BAR_H, rx: 2,
                fill: color
            });
            bindTip(rect, {
                value: valueFmt(p.value), title: p.label,
                rows: [{ label: 'Share', value: fmtPct(frac * 100) }]
            });
            rect.setAttribute('aria-label', `${p.label}: ${valueFmt(p.value)}, ${fmtPct(frac * 100)}`);
            marks.appendChild(rect);
            cursor += w + GAP;
        });
        svg.appendChild(marks);
        container.appendChild(h('div', { class: 'chart' }, [svg]));

        // Legend is always present for >=2 series.
        const legend = h('div', { class: 'chart-legend' });
        shown.forEach((p, i) => {
            const sw = h('span', { class: 'legend-swatch' });
            sw.style.background = cssVar(slotVar(i, p.isOther));
            legend.appendChild(h('span', { class: 'legend-item' }, [
                sw, h('span', { text: p.label }),
                h('span', { class: 'legend-count', text: ` ${valueFmt(p.value)}` })
            ]));
        });
        container.appendChild(legend);

        const table = tableTwin({
            caption: tableCaption,
            columns: [
                { key: 'label', label: 'Segment' },
                { key: 'value', label: 'Value', num: true },
                { key: 'share', label: 'Share', num: true }
            ],
            rows: shown.map(p => ({
                label: p.label, value: valueFmt(p.value),
                share: fmtPct((p.value / total) * 100)
            }))
        });
        container.appendChild(table);
        return { table, total };
    }

    // ═════════════════════════════════════════════════════════════════════
    // Day histogram — observed events per day from a feed.
    // This is a count of events the feed retained, NOT a persisted metric
    // trend; the caller is expected to label it as such.
    // opts: { days:[{key,count}], onSelect?, selected?, valueLabel }
    // ═════════════════════════════════════════════════════════════════════
    function dayHistogram(container, opts) {
        const { days = [], onSelect = null, selected = null, valueLabel = 'events', tableCaption = '' } = opts;
        container.textContent = '';
        if (!days.length) {
            container.appendChild(h('div', { class: 'chart-empty', text: 'No events in the retained window.' }));
            return;
        }
        const PAD_L = 34, AXIS_H = 20, plotH = 84;
        const W = Math.max(container.clientWidth || 760, 280);
        const H = plotH + AXIS_H;
        const plotW = W - PAD_L - 6;
        const max = Math.max(...days.map(d => d.count));
        const scale = niceScale(max, 3);
        const slotW = plotW / days.length;
        const barW = Math.min(slotW - 2, 24); // cap thickness; leftover is air

        const svg = svgEl('svg', {
            class: 'chart-svg', viewBox: `0 0 ${W} ${H}`, height: H,
            role: 'img', 'aria-label': `${tableCaption || 'Events per day'} — ${days.length} days`
        });
        const grid = svgEl('g', { class: 'chart-grid' });
        const axis = svgEl('g', { class: 'chart-axis' });
        for (const t of scale.ticks) {
            const gy = plotH - (t / scale.max) * plotH;
            grid.appendChild(svgEl('line', { x1: PAD_L, y1: gy, x2: W - 6, y2: gy }));
            axis.appendChild(svgEl('text', { x: PAD_L - 6, y: gy + 4, 'text-anchor': 'end', class: 'chart-tick', text: fmtAxisNum(t) }));
        }
        axis.appendChild(svgEl('line', { x1: PAD_L, y1: plotH, x2: W - 6, y2: plotH }));
        svg.appendChild(grid); svg.appendChild(axis);

        const marks = svgEl('g', { class: 'chart-marks' });
        days.forEach((d, i) => {
            const cx = PAD_L + i * slotW + slotW / 2;
            const bh = d.count > 0 ? Math.max((d.count / scale.max) * plotH, 2) : 0;
            const isSel = selected === d.key;
            if (bh > 0) {
                marks.appendChild(svgEl('path', {
                    class: 'chart-bar fill-seq',
                    d: roundedColumnPath(cx - barW / 2, plotH - bh, barW, bh, 4),
                    opacity: selected && !isSel ? 0.4 : 1
                }));
            }
            const hit = svgEl('rect', { class: 'chart-hit', x: cx - slotW / 2, y: 0, width: slotW, height: H });
            bindTip(hit, {
                value: `${fmtNum(d.count)} ${valueLabel}`,
                title: new Date(`${d.key}T00:00:00Z`).toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' })
            });
            if (onSelect && d.count > 0) {
                hit.style.cursor = 'pointer';
                hit.setAttribute('role', 'button');
                hit.setAttribute('aria-label', `${d.key}: ${d.count} ${valueLabel}`);
                hit.addEventListener('click', () => onSelect(d.key));
                hit.addEventListener('keydown', e => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(d.key); }
                });
            }
            marks.appendChild(hit);
        });
        svg.appendChild(marks);

        // Sparse x labels — first, middle, last only; never one per column.
        const xAxis = svgEl('g', { class: 'chart-axis' });
        [0, Math.floor(days.length / 2), days.length - 1].filter((v, i, a) => a.indexOf(v) === i).forEach(i => {
            const d = days[i]; if (!d) return;
            xAxis.appendChild(svgEl('text', {
                x: PAD_L + i * slotW + slotW / 2, y: plotH + 14,
                'text-anchor': i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle',
                class: 'chart-tick',
                text: new Date(`${d.key}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
            }));
        });
        svg.appendChild(xAxis);

        container.appendChild(h('div', { class: 'chart' }, [svg]));
        const table = tableTwin({
            caption: tableCaption,
            columns: [{ key: 'day', label: 'Day' }, { key: 'count', label: valueLabel, num: true }],
            rows: days.map(d => ({ day: d.key, count: fmtNum(d.count) }))
        });
        container.appendChild(table);
        return { table };
    }
    function roundedColumnPath(x, y, w, hgt, r) {
        const rr = Math.min(r, w / 2, hgt);
        if (hgt <= rr) return `M${x},${y + hgt} v${-hgt} h${w} v${hgt} Z`;
        return `M${x},${y + hgt} v${-(hgt - rr)} a${rr},${rr} 0 0 1 ${rr},${-rr} h${w - 2 * rr} a${rr},${rr} 0 0 1 ${rr},${rr} v${hgt - rr} Z`;
    }

    // ═════════════════════════════════════════════════════════════════════
    // Calendar heatmap — sequential single-hue ramp with a scale legend.
    // Renders three real month grids (previous / current / next: next month
    // carries scheduled maintenance). Monday-first, UTC day keys.
    // opts: { containerId|container, counts:Map<dayKey,n>, selected, onSelect, noun }
    // ═════════════════════════════════════════════════════════════════════
    function calendarHeatmap(container, opts) {
        const { counts = new Map(), selected = null, onSelect = null, noun = 'event' } = opts;
        container.textContent = '';
        const ramp = sequentialRamp();
        const max = Math.max(1, ...counts.values());
        const todayKey = new Date().toISOString().slice(0, 10);
        const now = new Date();

        // Bucket a count onto a ramp step. Any non-zero day gets at least the
        // first step, so "something happened" is never invisible.
        const stepFor = n => {
            if (!n) return null;
            const idx = Math.min(ramp.length - 1, Math.floor((n / max) * ramp.length));
            return ramp[Math.max(0, idx)];
        };

        for (let off = -1; off <= 1; off++) {
            const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + off, 1));
            const dim = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
            const grid = h('div', { class: 'cal-grid' },
                ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map(d => h('div', { class: 'cal-dow', text: d })));
            for (let i = (first.getUTCDay() + 6) % 7; i > 0; i--) grid.appendChild(h('div', { class: 'cal-cell is-blank' }));

            for (let d = 1; d <= dim; d++) {
                const key = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), d)).toISOString().slice(0, 10);
                const n = counts.get(key) || 0;
                const cls = ['cal-cell'];
                if (n) cls.push('has-data');
                if (selected === key) cls.push('is-selected');
                if (key === todayKey) cls.push('is-today');
                const cell = h(n ? 'button' : 'div', {
                    class: cls.join(' '), type: n ? 'button' : null,
                    'aria-label': `${key}: ${n} ${noun}${n === 1 ? '' : 's'}`,
                    'aria-pressed': n ? String(selected === key) : null
                }, [h('span', { class: 'cal-day', text: String(d) })]);
                if (n) {
                    cell.style.background = stepFor(n);
                    bindTip(cell, {
                        value: `${fmtNum(n)} ${noun}${n === 1 ? '' : 's'}`,
                        title: new Date(`${key}T00:00:00Z`).toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' })
                    }, { focusable: false });
                    if (onSelect) cell.addEventListener('click', () => onSelect(key));
                }
                grid.appendChild(cell);
            }
            container.appendChild(h('div', {}, [
                h('div', { class: 'cal-month-title', text: first.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }) }),
                grid
            ]));
        }
        return { max };
    }

    // Scale legend for the calendar / any sequential ramp.
    function scaleLegend(container, { lowLabel = 'fewer', highLabel = 'more', max = null, noun = '' } = {}) {
        container.textContent = '';
        const ramp = sequentialRamp();
        const bar = h('div', { class: 'scale-ramp' });
        for (const c of ramp) {
            const s = h('span', { class: 'scale-step' });
            s.style.background = c;
            bar.appendChild(s);
        }
        container.appendChild(h('span', { text: lowLabel }));
        container.appendChild(bar);
        container.appendChild(h('span', { text: max != null ? `${highLabel} (max ${max}${noun ? ` ${noun}` : ''}/day)` : highLabel }));
    }

    // ═════════════════════════════════════════════════════════════════════
    // Treemap — squarified (Bruls, Huizing & van Wijk). Area = magnitude.
    // Fill is a DIVERGING ramp (warm = up, cool = down, neutral midpoint) so
    // the polarity reads for colorblind users too; the previous red/green
    // pairing was the single worst choice for that.
    // opts: { nodes:[{id,label,value,signal}], height, onSelect, selectedId,
    //         focus, valueFmt, signalFmt, tableCaption }
    // ═════════════════════════════════════════════════════════════════════
    function treemap(container, opts) {
        const {
            nodes = [], height = 420, onSelect = null, selectedId = null,
            focusIds = null, valueFmt = fmtNum, signalFmt = null, tableCaption = '',
            neutralBand = 0.05
        } = opts;
        container.textContent = '';
        if (!nodes.length) {
            container.style.height = 'auto';
            container.appendChild(h('div', { class: 'chart-empty', text: 'No data available.' }));
            return;
        }
        const width = container.clientWidth || 900;
        const tiles = squarify(nodes.map(n => ({ ref: n, value: n.value })), 0, 0, width, height);
        const warm = cssVar('--div-warm'), cool = cssVar('--div-cool'), midc = cssVar('--div-mid');
        const GAP = 2;

        // A node may supply `signalLabel` to state the true figure while
        // `signal` stays clamped for the colour ramp — clamping the number the
        // reader sees would misreport the extremes.
        const labelFor = n => n.signalLabel ?? (signalFmt ? signalFmt(n.signal) : null);

        for (const t of tiles) {
            const n = t.ref;
            const sig = Number.isFinite(n.signal) ? Math.max(-1, Math.min(1, n.signal)) : 0;
            // Diverging fill: |signal| drives distance from the neutral midpoint.
            const fill = sig > neutralBand ? mix(midc, warm, Math.min(1, sig))
                : sig < -neutralBand ? mix(midc, cool, Math.min(1, -sig))
                : midc;
            const isSel = selectedId != null && n.id === selectedId;
            const tile = h('button', {
                class: 'tm-tile', type: 'button',
                'aria-pressed': String(isSel),
                'aria-label': `${n.label}: ${valueFmt(n.value)}${labelFor(n) ? `, ${labelFor(n)}` : ''}`
            });
            tile.style.left = `${t.x + GAP / 2}px`;
            tile.style.top = `${t.y + GAP / 2}px`;
            tile.style.width = `${Math.max(0, t.w - GAP)}px`;
            tile.style.height = `${Math.max(0, t.h - GAP)}px`;
            tile.style.background = fill;
            if (focusIds && focusIds.has(n.id)) tile.style.outline = `2px solid ${cssVar('--accent')}`;
            if (focusIds && focusIds.has(n.id)) tile.style.outlineOffset = '-2px';

            // Only draw a label when it actually fits — never clip text.
            if (t.w > 52 && t.h > 24) {
                const fs = Math.max(10, Math.min(16, Math.round(t.w / 11)));
                const maxChars = Math.floor((t.w - 12) / (fs * 0.56));
                const label = h('span', { class: 'tm-name', text: truncate(n.label, Math.max(3, maxChars)) });
                label.style.fontSize = `${fs}px`;
                // Pick ink by fill luminance so the label always clears contrast.
                label.style.color = luminanceOf(fill) > 0.5 ? '#0d1117' : '#ffffff';
                tile.appendChild(label);
            }
            bindTip(tile, {
                value: valueFmt(n.value), title: n.label,
                rows: labelFor(n) ? [{ label: 'Momentum', value: labelFor(n) }] : [],
                note: n.note
            }, { focusable: false });
            if (onSelect) tile.addEventListener('click', () => onSelect(n.id));
            container.appendChild(tile);
        }
        container.style.height = `${height}px`;

        const table = tableTwin({
            caption: tableCaption,
            columns: [
                { key: 'label', label: 'Name' },
                { key: 'value', label: 'Value', num: true },
                ...(nodes.some(n => labelFor(n) != null) ? [{ key: 'signal', label: 'Momentum' }] : [])
            ],
            rows: nodes.map(n => ({
                label: n.label, value: valueFmt(n.value),
                signal: labelFor(n) ?? undefined
            }))
        });
        return { table };
    }

    function luminanceOf(color) {
        const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(color);
        const rgb = m ? [+m[1], +m[2], +m[3]] : hexToRgb(color);
        if (!rgb) return 0;
        const [r, g, b] = rgb.map(v => {
            const s = v / 255;
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }

    function squarify(children, x, y, w, h0) {
        const out = [];
        const nodes = children.filter(c => c.value > 0).sort((a, b) => b.value - a.value);
        const total = nodes.reduce((s, c) => s + c.value, 0);
        if (total <= 0 || w <= 0 || h0 <= 0) return out;
        const items = nodes.map(c => ({ ref: c.ref, area: (c.value / total) * (w * h0) }));

        const worst = (row, side) => {
            const sum = row.reduce((s, r) => s + r.area, 0);
            let mx = -Infinity, mn = Infinity;
            for (const r of row) { if (r.area > mx) mx = r.area; if (r.area < mn) mn = r.area; }
            const s2 = sum * sum, l2 = side * side;
            return Math.max((l2 * mx) / s2, s2 / (l2 * mn));
        };

        const rect = { x, y, w, h: h0 };
        let i = 0;
        while (i < items.length) {
            const side = Math.min(rect.w, rect.h);
            const row = [items[i]];
            let j = i + 1;
            while (j < items.length && worst(row, side) >= worst(row.concat(items[j]), side)) { row.push(items[j]); j++; }
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

    // ═════════════════════════════════════════════════════════════════════
    globalThis.Viz = {
        barChart, compositionBar, dayHistogram, calendarHeatmap, scaleLegend, treemap,
        tableTwin, attachTableToggle,
        fmtUsd, fmtNum, fmtPct, fmtAxisUsd, fmtAxisNum, niceScale,
        cssVar, mix, sequentialRamp, truncate,
        showTip, hideTip, bindTip, h, svgEl
    };
})();
