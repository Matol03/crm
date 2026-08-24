/**
 * Duplicate review — side-by-side comparison with the matching signals that
 * triggered the flag.
 *
 * Merging is destructive, so it is never the incidental action: differing
 * fields are highlighted, the surviving record is stated explicitly, and the
 * merge is confirmed in a drawer rather than fired from a single click.
 */

import { h, icon, replace, fmtDateTime, fmtAgo } from '../ui/dom.js';
import { panel, confidence, badge, emptyState, openDrawer, toast, banner } from '../ui/primitives.js';
import { getDuplicates } from '../api.js';
import { navigate } from '../router.js';

const ROWS = [
  ['name', 'Name'], ['company', 'Company'], ['position', 'Position'],
  ['phone', 'Phone'], ['email', 'Email'],
];

export async function renderDuplicates(root) {
  const { data } = await getDuplicates();
  const pairs = [...data];

  const host = h('div.stack-6');

  function resolve(pair, message) {
    const i = pairs.indexOf(pair);
    if (i >= 0) pairs.splice(i, 1);
    paint();
    toast(message, 'ok');
  }

  function confirmMerge(pair) {
    openDrawer({
      title: 'Merge these leads?',
      subtitle: `${pair.left.name} · ${pair.left.company}`,
      body: h('div.stack-4',
        banner('warn',
          h('div',
            h('div.fw-medium', 'This cannot be undone from here'),
            h('div.t-xs', { style: { marginTop: '2px' } },
              `Lead #${pair.right.bitrixLeadId} will be merged into #${pair.left.bitrixLeadId}. `
              + 'Source messages and evidence from both are preserved on the surviving lead.'))),
        h('div',
          h('div.eyebrow', { style: { marginBottom: 'var(--sp-2)' } }, 'Surviving lead'),
          h('div.panel', { style: { padding: 'var(--sp-3)' } },
            h('div.fw-medium', `#${pair.left.bitrixLeadId} · ${pair.left.name}`),
            h('div.t-xs.subtle', `${pair.left.company} · created ${fmtDateTime(pair.left.createdAt)} · owner ${pair.left.owner.name}`))),
        h('div',
          h('div.eyebrow', { style: { marginBottom: 'var(--sp-2)' } }, 'Will be merged and closed'),
          h('div.panel', { style: { padding: 'var(--sp-3)' } },
            h('div.fw-medium', `#${pair.right.bitrixLeadId} · ${pair.right.name}`),
            h('div.t-xs.subtle', `${pair.right.company} · created ${fmtDateTime(pair.right.createdAt)} · owner ${pair.right.owner.name}`))),
      ),
      footer: (close) => [
        h('button.btn.btn-danger', {
          onclick: () => { resolve(pair, `Merged #${pair.right.bitrixLeadId} into #${pair.left.bitrixLeadId}`); close(); },
        }, icon('merge', 13), 'Merge leads'),
        h('button.btn', { onclick: close }, 'Cancel'),
      ],
    });
  }

  function comparison(pair) {
    const differs = (key) => String(pair.left[key] ?? '').trim() !== String(pair.right[key] ?? '').trim();

    const side = (rec, kept) => h('div.compare-card' + (kept ? '.is-kept' : ''),
      h('div.compare-head',
        h('div.between',
          h('div.fw-semibold', `Lead #${rec.bitrixLeadId}`),
          kept ? badge('Will be kept', 'ok') : badge('Will be merged', 'neutral')),
        h('div.t-xs.subtle', { style: { marginTop: '2px' } },
          `${rec.owner.name} · ${fmtAgo(rec.createdAt)}`)),
      ROWS.map(([key, label]) => h('div.compare-row' + (differs(key) ? '.differs' : ''),
        h('span.subtle', label),
        h('span', { class: key === 'phone' || key === 'email' ? 'mono' : null }, rec[key] || '—'))),
      h('div', { style: { padding: 'var(--sp-3) var(--sp-4)' } },
        h('button.btn.btn-sm.btn-block', { onclick: () => navigate(`leads/${rec.id}`) }, 'Open lead')),
    );

    return h('section.panel',
      h('div.panel-head',
        h('div',
          h('h2.panel-title', 'Possible duplicate'),
          h('div.t-xs.subtle', { style: { marginTop: '2px' } }, `Detected ${fmtAgo(pair.detectedAt)}`)),
        h('div', { style: { minWidth: '160px' } },
          h('div.eyebrow', { style: { marginBottom: '4px', textAlign: 'right' } }, 'Similarity'),
          confidence(pair.similarity))),

      h('div.panel-body',
        h('div.compare', side(pair.left, true), side(pair.right, false)),

        pair.note ? h('div', { style: { marginTop: 'var(--sp-4)' } }, banner('info', h('div', pair.note))) : null,

        h('div', { style: { marginTop: 'var(--sp-5)' } },
          h('div.eyebrow', { style: { marginBottom: 'var(--sp-2)' } }, 'Matching signals'),
          h('div.grid.grid-2', { style: { gap: '0 var(--sp-6)' } },
            pair.signals.map((s) => h(`div.signal.${s.match ? 'yes' : 'no'}`,
              h('span.mark', s.match ? '✓' : '✕'), s.label)))),

        h('div.row', { style: { marginTop: 'var(--sp-5)', gap: 'var(--sp-3)' } },
          h('button.btn.btn-primary', { onclick: () => confirmMerge(pair) }, icon('merge', 13), 'Merge…'),
          h('button.btn', { onclick: () => resolve(pair, 'Kept as two separate leads') }, icon('split', 13), 'Keep separate'),
          h('span.t-xs.subtle', { style: { marginLeft: 'auto' } },
            'Two managers meeting the same visitor is expected — keeping them separate is often correct.'))),
    );
  }

  function paint() {
    replace(host, pairs.length
      ? pairs.map(comparison)
      : panel({ body: emptyState({
          tone: 'ok',
          title: 'No duplicates to review',
          note: 'Every lead currently looks distinct. New matches appear here automatically.',
        }) }));
  }

  paint();

  replace(root,
    h('div.page-head',
      h('div',
        h('h1.page-title', 'Duplicate review'),
        h('p.page-subtitle', 'Compare the evidence before merging — merges cannot be undone here')),
      h('div.row', h('span.t-sm.subtle', `${pairs.length} pending`))),
    host,
  );
}
