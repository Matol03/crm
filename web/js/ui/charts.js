/**
 * Hand-rolled SVG charts.
 *
 * No charting library: the app ships zero dependencies, and these four shapes
 * cover everything the analytics screen needs. All colours come from the design
 * tokens so charts match the rest of the UI automatically.
 */

import { h } from './dom.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(name, attrs = {}) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v != null) el.setAttribute(k, v);
  }
  return el;
}

export const SERIES_COLORS = ['var(--c-accent)', 'var(--c-purple)', 'var(--c-conf-high)', 'var(--c-warn)'];

/**
 * Grouped column chart — used for "leads over time" split by lead type.
 * @param data   [{ label, ...seriesValues }]
 * @param series [{ key, label, color }]
 */
export function columnChart(data, series, { height = 190 } = {}) {
  const w = 640;
  const padL = 30, padR = 8, padT = 10, padB = 26;
  const innerW = w - padL - padR;
  const innerH = height - padT - padB;
  const max = Math.max(1, ...data.flatMap((d) => series.map((s) => d[s.key] || 0)));
  // Round the axis up to a friendly number so gridlines read cleanly.
  const top = Math.ceil(max / 10) * 10 || 10;

  const svg = svgEl('svg', { class: 'chart', viewBox: `0 0 ${w} ${height}`, role: 'img' });

  // Horizontal gridlines + y labels.
  for (let i = 0; i <= 4; i++) {
    const y = padT + (innerH / 4) * i;
    svg.append(svgEl('line', { class: 'grid-line', x1: padL, x2: w - padR, y1: y, y2: y }));
    const label = svgEl('text', { class: 'axis-label', x: padL - 6, y: y + 3, 'text-anchor': 'end' });
    label.textContent = Math.round(top - (top / 4) * i);
    svg.append(label);
  }

  const groupW = innerW / data.length;
  const barW = Math.min(18, (groupW - 10) / series.length);

  data.forEach((d, gi) => {
    const gx = padL + groupW * gi + groupW / 2;
    series.forEach((s, si) => {
      const v = d[s.key] || 0;
      const bh = (v / top) * innerH;
      const x = gx - (barW * series.length) / 2 + barW * si;
      svg.append(svgEl('rect', {
        x, y: padT + innerH - bh, width: Math.max(2, barW - 2), height: Math.max(0, bh),
        rx: 2, fill: s.color || SERIES_COLORS[si % SERIES_COLORS.length],
      }));
    });
    const xl = svgEl('text', { class: 'axis-label', x: gx, y: height - 8, 'text-anchor': 'middle' });
    xl.textContent = d.label;
    svg.append(xl);
  });

  return h('div',
    svg,
    h('div.legend', { style: { marginTop: 'var(--sp-3)' } },
      series.map((s, i) => h('span.legend-item',
        h('span.legend-swatch', { style: { background: s.color || SERIES_COLORS[i % SERIES_COLORS.length] } }),
        s.label))),
  );
}

/**
 * Horizontal bar list — the clearest form for ranked categories
 * (product interest, manager, priority).
 */
export function barList(items, { max, showValue = true, color } = {}) {
  const peak = max ?? Math.max(1, ...items.map((i) => i.value));
  return h('div',
    items.map((item) => h('div.bar-row',
      h('span.truncate', { title: item.label }, item.label),
      h('div.bar-track',
        h('div.bar-fill', {
          style: {
            width: `${Math.max(1, (item.value / peak) * 100)}%`,
            background: item.tone ? `var(--c-${item.tone})` : color || 'var(--c-accent)',
          },
        })),
      showValue && h('span.conf-value', item.value),
    )),
  );
}

/** Donut — used for the Customer / Partner split. */
export function donut(segments, { size = 148, thickness = 18, centerLabel, centerValue } = {}) {
  const total = segments.reduce((n, s) => n + s.value, 0) || 1;
  const r = (size - thickness) / 2;
  const c = size / 2;
  const circumference = 2 * Math.PI * r;

  const svg = svgEl('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size, role: 'img' });
  svg.append(svgEl('circle', {
    cx: c, cy: c, r, fill: 'none', stroke: 'var(--c-surface-sunken)', 'stroke-width': thickness,
  }));

  let offset = 0;
  segments.forEach((s, i) => {
    const len = (s.value / total) * circumference;
    svg.append(svgEl('circle', {
      cx: c, cy: c, r, fill: 'none',
      stroke: s.color || SERIES_COLORS[i % SERIES_COLORS.length],
      'stroke-width': thickness,
      'stroke-dasharray': `${len} ${circumference - len}`,
      'stroke-dashoffset': -offset,
      transform: `rotate(-90 ${c} ${c})`,
    }));
    offset += len;
  });

  if (centerValue != null) {
    const v = svgEl('text', { x: c, y: c - 2, 'text-anchor': 'middle', fill: 'var(--c-text)',
      'font-size': '20', 'font-weight': '600' });
    v.textContent = centerValue;
    svg.append(v);
    const l = svgEl('text', { x: c, y: c + 14, 'text-anchor': 'middle', fill: 'var(--c-text-subtle)', 'font-size': '10' });
    l.textContent = centerLabel || '';
    svg.append(l);
  }

  return h('div.row-4', { style: { alignItems: 'center', gap: 'var(--sp-6)' } },
    svg,
    h('div.col',
      segments.map((s, i) => h('div.row', { style: { gap: '8px' } },
        h('span.legend-swatch', { style: { background: s.color || SERIES_COLORS[i % SERIES_COLORS.length] } }),
        h('span.t-sm.grow', s.label),
        h('span.t-sm.fw-medium.tnum', s.value),
        h('span.t-xs.subtle', `${Math.round((s.value / total) * 100)}%`)))),
  );
}

/** Sparkline-style latency readout (p50/p90/p99). */
export function statStrip(items) {
  return h('div.grid.grid-3',
    items.map((i) => h('div',
      h('div.t-xs.subtle', i.label),
      h('div.metric-value.sm', { style: { marginTop: '2px' } }, `${i.value}${i.unit || ''}`))),
  );
}
