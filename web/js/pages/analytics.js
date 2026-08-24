/**
 * Analytics — compact and metric-led, mapped to the measures the brief asks for
 * (volume, mix, quality, latency, duplicate and review rates).
 */

import { h, replace, fmtNum, fmtPct1 } from '../ui/dom.js';
import { panel, metric, confidence } from '../ui/primitives.js';
import { columnChart, barList, donut, statStrip, SERIES_COLORS } from '../ui/charts.js';
import { getAnalytics } from '../api.js';

export async function renderAnalytics(root) {
  const { data: a, source } = await getAnalytics();

  replace(root,
    h('div.page-head',
      h('div',
        h('h1.page-title', 'Analytics'),
        h('p.page-subtitle',
          'Campaign performance and processing quality',
          source === 'demo' ? ' · demo fixtures' : ''))),

    // ── Totals ────────────────────────────────────────────────────────
    h('div.grid.grid-4',
      metric({ label: 'Total leads', value: fmtNum(a.totals.leads), note: 'this campaign' }),
      metric({ label: 'Customers', value: fmtNum(a.totals.customers), note: `${Math.round(a.totals.customers / a.totals.leads * 100)}% of leads` }),
      metric({ label: 'Partners', value: fmtNum(a.totals.partners), note: `${Math.round(a.totals.partners / a.totals.leads * 100)}% of leads` }),
      metric({ label: 'High priority', value: fmtNum(a.totals.highPriority), note: 'need fast follow-up', tone: 'danger' }),
    ),

    // ── Volume over time + mix ────────────────────────────────────────
    h('div.grid', { style: { marginTop: 'var(--sp-6)', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)', alignItems: 'start' } },
      panel({
        title: 'Leads over time',
        subtitle: 'Split by lead type',
        body: columnChart(a.overTime, [
          { key: 'customers', label: 'Customer', color: SERIES_COLORS[0] },
          { key: 'partners', label: 'Partner', color: SERIES_COLORS[1] },
        ]),
      }),
      panel({
        title: 'Customer vs Partner',
        body: donut(
          [
            { label: 'Customer', value: a.totals.customers, color: SERIES_COLORS[0] },
            { label: 'Partner', value: a.totals.partners, color: SERIES_COLORS[1] },
          ],
          { centerValue: fmtNum(a.totals.leads), centerLabel: 'leads' },
        ),
      }),
    ),

    // ── Breakdowns ────────────────────────────────────────────────────
    h('div.grid.grid-3', { style: { marginTop: 'var(--sp-4)', alignItems: 'start' } },
      panel({ title: 'By product interest', body: barList(a.byInterest) }),
      panel({ title: 'By priority', body: barList(a.byPriority) }),
      panel({ title: 'By manager', body: barList(a.byManager) }),
    ),

    // ── Quality + latency ─────────────────────────────────────────────
    h('div.grid', { style: { marginTop: 'var(--sp-4)', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', alignItems: 'start' } },
      panel({
        title: 'Processing quality',
        subtitle: 'How reliable the automated path is',
        body: h('div.col', { style: { gap: 'var(--sp-4)' } },
          a.quality.map((q) => h('div',
            h('div.between', { style: { marginBottom: '6px' } },
              h('span.t-sm', q.label),
              h('span.t-sm.fw-medium.tnum', fmtPct1(q.value))),
            // "Manual review" is good when low, so its bar is inverted.
            confidence(q.invert ? 1 - q.value : q.value, { showValue: false })))),
      }),
      panel({
        title: 'Processing latency',
        subtitle: 'Message received → lead in Bitrix24',
        body: h('div',
          statStrip(a.latency),
          h('div.grid.grid-2', { style: { marginTop: 'var(--sp-6)' } },
            h('div',
              h('div.t-xs.subtle', 'Duplicate rate'),
              h('div.metric-value.sm', fmtPct1(a.rates.duplicate))),
            h('div',
              h('div.t-xs.subtle', 'Manual review rate'),
              h('div.metric-value.sm', fmtPct1(a.rates.review))))),
      }),
    ),
  );
}
