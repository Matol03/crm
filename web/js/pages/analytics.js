/**
 * Analytics — computed from the leads currently in Bitrix24.
 *
 * Every figure here is a count over real portal data. Where a dimension has not
 * been recorded on any lead yet, the panel says so rather than drawing an empty
 * chart that would read as a zero.
 */

import { h, replace, fmtNum } from '../ui/dom.js';
import { panel, metric, apiErrorState, emptyState } from '../ui/primitives.js';
import { barList, donut, SERIES_COLORS } from '../ui/charts.js';
import { getAnalytics } from '../api.js';

export async function renderAnalytics(root) {
  let a;
  try {
    a = await getAnalytics();
  } catch (err) {
    replace(root, apiErrorState(err, () => renderAnalytics(root)));
    return;
  }

  const share = (n) => (a.totals.leads ? `${Math.round((n / a.totals.leads) * 100)}% of leads` : '—');
  const orEmpty = (rows, note) => (rows.length ? barList(rows) : h('p.t-sm.faint', note));

  const head = h('div.page-head',
    h('div',
      h('h1.page-title', 'Analytics'),
      h('p.page-subtitle', 'Computed from the leads currently in Bitrix24')));

  if (!a.totals.leads) {
    replace(root, head, panel({
      body: emptyState({
        title: 'No leads yet',
        note: 'Analytics appear as soon as the portal has leads. Post a message in the Teams channel to create one.',
      }),
    }));
    return;
  }

  replace(root,
    head,

    // ── Totals ────────────────────────────────────────────────────────
    h('div.grid.grid-4',
      metric({ label: 'Total leads', value: fmtNum(a.totals.leads), note: 'in this portal' }),
      metric({ label: 'Customers', value: fmtNum(a.totals.customers), note: share(a.totals.customers) }),
      metric({ label: 'Partners', value: fmtNum(a.totals.partners), note: share(a.totals.partners) }),
      metric({
        label: 'High priority', value: fmtNum(a.totals.highPriority),
        note: 'need fast follow-up',
        tone: a.totals.highPriority ? 'danger' : undefined,
      }),
    ),

    // ── Mix + funnel ──────────────────────────────────────────────────
    h('div.grid', { style: { marginTop: 'var(--sp-6)', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', alignItems: 'start' } },
      panel({
        title: 'Customer vs Partner',
        body: a.totals.customers + a.totals.partners
          ? donut(
              [
                { label: 'Customer', value: a.totals.customers, color: SERIES_COLORS[0] },
                { label: 'Partner', value: a.totals.partners, color: SERIES_COLORS[1] },
              ],
              { centerValue: fmtNum(a.totals.leads), centerLabel: 'leads' },
            )
          : h('p.t-sm.faint', 'Lead type has not been set on any lead yet.'),
      }),
      panel({
        title: 'By status',
        subtitle: 'Where leads sit in the funnel',
        body: orEmpty(a.byStatus, 'No statuses recorded.'),
      }),
    ),

    // ── Breakdowns ────────────────────────────────────────────────────
    h('div.grid.grid-3', { style: { marginTop: 'var(--sp-4)', alignItems: 'start' } },
      panel({ title: 'By product interest', body: orEmpty(a.byInterest, 'Not recorded on any lead yet.') }),
      panel({ title: 'By priority', body: orEmpty(a.byPriority, 'Not recorded on any lead yet.') }),
      panel({ title: 'By owner', body: orEmpty(a.byManager, 'No owners resolved.') }),
    ),

    // ── Volume ────────────────────────────────────────────────────────
    h('div', { style: { marginTop: 'var(--sp-4)' } },
      panel({
        title: 'Leads created over time',
        subtitle: 'By day, from the portal’s own creation dates',
        body: orEmpty(a.overTime, 'No creation dates available.'),
      })),
  );
}
