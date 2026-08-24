/**
 * Activity log — what the service has actually been doing.
 *
 * Parsed from the poller's own output: polls, grouped sessions, the leads each
 * produced, warnings, quota pauses and errors. This is the operational
 * counterpart to the per-lead journal on the detail screen.
 */

import { h, icon, replace, fmtTime, fmtDateTime } from '../ui/dom.js';
import { panel, badge, emptyState, apiErrorState } from '../ui/primitives.js';
import { getLogs } from '../api.js';

/** How each parsed entry is presented. */
const KIND = {
  poll:      { tone: 'info',    label: 'Poll' },
  message:   { tone: 'neutral', label: 'Message' },
  session:   { tone: 'info',    label: 'Session' },
  result:    { tone: 'ok',      label: 'Result' },
  lead:      { tone: 'ok',      label: 'Lead' },
  reply:     { tone: 'neutral', label: 'Reply' },
  warn:      { tone: 'warn',    label: 'Warning' },
  error:     { tone: 'danger',  label: 'Error' },
  quota:     { tone: 'warn',    label: 'Quota' },
  watermark: { tone: 'neutral', label: 'Watermark' },
  info:      { tone: 'neutral', label: 'Info' },
};

export async function renderLogs(root) {
  let data;
  try {
    data = await getLogs(300);
  } catch (err) {
    replace(root, apiErrorState(err, () => renderLogs(root)));
    return;
  }

  const all = data.entries || [];
  let filter = '';

  const head = h('div.page-head',
    h('div',
      h('h1.page-title', 'Activity log'),
      h('p.page-subtitle', 'What the service has been doing, newest first')),
    h('div.row',
      h('button.btn', { onclick: () => renderLogs(root) }, icon('refresh', 13), 'Refresh')));

  if (!all.length) {
    replace(root, head, panel({
      body: emptyState({
        title: 'No activity recorded yet',
        note: 'The log fills as the poller reads the Teams channel and creates leads.',
      }),
    }));
    return;
  }

  const body = h('div');

  const row = (e) => {
    const meta = KIND[e.kind] || KIND.info;
    // Prefer the structured fields; fall back to the raw line so nothing hides.
    const text = e.kind === 'message'
      ? `${e.author} · ${(e.types || []).join(', ')}`
      : e.kind === 'lead' ? e.title
      : e.kind === 'result' ? `${e.leads} lead(s) · ${e.status}`
      : e.kind === 'poll' ? `${e.count} new message(s)`
      : e.kind === 'session' ? `${e.author} · ${e.items} item(s)`
      : e.detail || e.text;

    return h('div.feed-item',
      h('div.feed-time', e.ts ? fmtTime(e.ts) : ''),
      h(`div.feed-icon.${meta.tone === 'neutral' ? 'info' : meta.tone}`,
        icon(meta.tone === 'danger' || meta.tone === 'warn' ? 'alert'
          : meta.tone === 'ok' ? 'check' : 'clock', 11)),
      h('div.feed-body',
        h('div.feed-title', text || '—'),
        e.kind === 'lead' && e.url && e.url !== '#'
          ? h('a.feed-note', { href: e.url, target: '_blank', rel: 'noopener' }, e.url)
          : e.text && e.text !== text ? h('div.feed-note.truncate', e.text) : null),
      h('div', { style: { alignSelf: 'center' } }, badge(meta.label, meta.tone)),
    );
  };

  function paint() {
    const rows = filter ? all.filter((e) => e.kind === filter) : all;
    replace(body, rows.length
      ? rows.map(row)
      : emptyState({ title: 'Nothing matches this filter', note: 'Choose a different category.' }));
    countEl.textContent = `${rows.length} of ${all.length}`;
  }

  const countEl = h('span.t-sm.subtle');
  const kinds = [...new Set(all.map((e) => e.kind))];

  const select = h('select.select', {
    onchange: (e) => { filter = e.target.value; paint(); },
  },
    h('option', { value: '' }, 'All activity'),
    kinds.map((k) => h('option', { value: k }, (KIND[k] || KIND.info).label)));

  paint();

  replace(root, head,
    panel({
      flush: true,
      body: h('div',
        h('div.filters', select, h('span.right', countEl)),
        body),
    }),
  );
}
