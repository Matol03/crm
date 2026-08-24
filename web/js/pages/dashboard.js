/**
 * Dashboard — the operational home screen.
 *
 * Answers, top to bottom: is the system running, what has it produced, where is
 * work stuck in the pipeline, and what happened in the last few minutes.
 */

import { h, icon, replace, fmtNum, fmtPct1, fmtTime, fmtAgo } from '../ui/dom.js';
import { panel, metric, statusBadge, skeleton, errorState, badge } from '../ui/primitives.js';
import { getDashboard } from '../api.js';
import { navigate } from '../router.js';
import { state } from '../state.js';

/** The pipeline strip — the product's architecture, made visible. */
function pipeline(stages) {
  return h('div.pipeline',
    stages.map((s) => h(
      'div.pipe-stage' + (s.active ? '.is-active' : '') + (s.terminal ? '.is-terminal' : ''),
      h('div.pipe-stage-name', s.name),
      h('div.pipe-stage-count', fmtNum(s.count)),
      h('div.pipe-stage-note', s.note),
    )),
  );
}

function activityRow(item) {
  const iconName = item.tone === 'ok' ? 'check' : item.tone === 'danger' ? 'alert'
    : item.tone === 'warn' ? 'alert' : 'refresh';
  return h('div.feed-item',
    h('div.feed-time', fmtTime(item.ts)),
    h(`div.feed-icon.${item.tone}`, icon(iconName, 11)),
    h('div.feed-body',
      h('div.feed-title.truncate', item.title),
      h('div.feed-note', item.note)),
    h('div', { style: { alignSelf: 'center' } },
      item.tone === 'ok' ? badge(item.state, 'ok')
        : item.tone === 'danger' ? badge(item.state, 'danger')
        : item.tone === 'warn' ? badge(item.state, 'warn')
        : badge(item.state, 'info')),
  );
}

export async function renderDashboard(root) {
  replace(root,
    h('div.page-head',
      h('div',
        h('h1.page-title', state.campaign),
        h('p.page-subtitle', 'Live message processing and CRM delivery'))),
    h('div.grid.grid-4', Array.from({ length: 4 }, () => h('div.panel.metric', skeleton(2)))),
    h('div', { style: { marginTop: 'var(--sp-4)' } }, panel({ body: skeleton(4) })),
  );

  let result;
  try {
    result = await getDashboard();
  } catch (err) {
    replace(root, errorState({
      title: 'Could not load the dashboard',
      note: 'The interface could not reach the lead service. Your data is unaffected — this screen only reads.',
      retry: () => renderDashboard(root),
    }));
    return;
  }

  const { kpis, pipeline: stages, activity } = result.data;
  const isDemo = result.source === 'demo';

  replace(root,
    h('div.page-head',
      h('div',
        h('h1.page-title', state.campaign),
        h('p.page-subtitle',
          'Live message processing and CRM delivery',
          isDemo ? ' · showing demo fixtures' : ' · connected to the live service')),
      h('div.row',
        h('button.btn', { onclick: () => navigate('leads') }, 'View all leads', icon('chevronRight', 13)))),

    // ── Primary KPIs ──────────────────────────────────────────────────
    h('div.grid.grid-4',
      metric({ label: 'Messages', value: fmtNum(kpis.messages), delta: kpis.messagesDelta, note: 'today' }),
      metric({ label: 'Leads', value: fmtNum(kpis.leads), delta: kpis.leadsDelta, note: 'created' }),
      metric({
        label: 'Needs review', value: fmtNum(kpis.review),
        note: kpis.review ? 'awaiting a decision' : 'nothing waiting',
        tone: kpis.review ? 'warn' : undefined,
      }),
      metric({
        label: 'Errors', value: fmtNum(kpis.errors),
        note: kpis.errors ? 'retryable' : 'none',
        tone: kpis.errors ? 'danger' : undefined,
      }),
    ),

    // ── Secondary KPIs ────────────────────────────────────────────────
    h('div.grid.grid-3', { style: { marginTop: 'var(--sp-4)' } },
      metric({ label: 'Duplicates detected', value: kpis.duplicates == null ? '—' : fmtNum(kpis.duplicates), note: 'flagged for review' }),
      metric({ label: 'Avg processing', value: kpis.avgProcessingSec == null ? '—' : `${kpis.avgProcessingSec} sec`, note: 'message → CRM' }),
      metric({ label: 'CRM success', value: kpis.crmSuccess == null ? '—' : fmtPct1(kpis.crmSuccess), delta: kpis.crmDelta, note: 'writes accepted' }),
    ),

    // ── Pipeline ──────────────────────────────────────────────────────
    h('div', { style: { marginTop: 'var(--sp-6)' } },
      panel({
        title: 'Processing pipeline',
        subtitle: 'Every message travels this path — counts show what is in each stage right now',
        flush: true,
        body: pipeline(stages),
      })),

    // ── Live feed ─────────────────────────────────────────────────────
    h('div', { style: { marginTop: 'var(--sp-4)' } },
      panel({
        title: 'Live processing',
        actions: [statusBadge('processing')],
        flush: true,
        body: activity.length
          ? h('div', activity.map(activityRow))
          : h('div.state', h('div.state-title', 'Nothing processing'), h('p.state-note', 'New Teams messages will appear here within seconds.')),
      })),

    activity.length ? h('div.t-xs.subtle', { style: { marginTop: 'var(--sp-3)', textAlign: 'right' } },
      `Last activity ${fmtAgo(activity[0].ts)}`) : null,
  );
}
