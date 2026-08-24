/**
 * Duplicate review — leads in Bitrix24 that share a phone or email.
 *
 * Computed live from the portal rather than from a stored decision, so it always
 * reflects the CRM as it is now. Merging is not offered here: two managers
 * meeting the same visitor is a legitimate outcome, and a real merge belongs in
 * Bitrix24 itself, where its consequences are visible.
 */

import { h, icon, replace, fmtDateTime } from '../ui/dom.js';
import { panel, confidence, badge, emptyState, apiErrorState, banner } from '../ui/primitives.js';
import { getDuplicates } from '../api.js';
import { navigate } from '../router.js';

const ROWS = [
  ['name', 'Name'], ['company', 'Company'], ['position', 'Position'],
  ['owner', 'Owner'], ['statusLabel', 'Status'],
];

export async function renderDuplicates(root) {
  let pairs;
  try {
    pairs = await getDuplicates();
  } catch (err) {
    replace(root, apiErrorState(err, () => renderDuplicates(root)));
    return;
  }

  const head = h('div.page-head',
    h('div',
      h('h1.page-title', 'Duplicate review'),
      h('p.page-subtitle', 'Leads sharing a phone number or email address')),
    h('div.row', h('span.t-sm.subtle', `${pairs.length} pair${pairs.length === 1 ? '' : 's'}`)));

  if (!pairs.length) {
    replace(root, head, panel({
      body: emptyState({
        tone: 'ok',
        title: 'No duplicates found',
        note: 'No two leads in the portal share a phone number or email address.',
      }),
    }));
    return;
  }

  const side = (rec, other) => h('div.compare-card',
    h('div.compare-head',
      h('div.between',
        h('div.fw-semibold', `Lead #${rec.bitrixLeadId}`),
        badge(rec.fromPipeline ? 'From Teams' : 'Entered manually', rec.fromPipeline ? 'info' : 'neutral')),
      h('div.t-xs.subtle', { style: { marginTop: '2px' } }, fmtDateTime(rec.createdAt))),
    ROWS.map(([key, label]) => {
      const differs = String(rec[key] ?? '') !== String(other[key] ?? '');
      return h('div.compare-row' + (differs ? '.differs' : ''),
        h('span.subtle', label),
        h('span', rec[key] || '—'));
    }),
    h('div.compare-row',
      h('span.subtle', 'Contact'),
      h('span.mono.t-xs', [...(rec.emails || []), ...(rec.phones || [])].join(' · ') || '—')),
    h('div', { style: { padding: 'var(--sp-3) var(--sp-4)' } },
      h('button.btn.btn-sm.btn-block', { onclick: () => navigate(`leads/${rec.bitrixLeadId}`) }, 'Open lead')),
  );

  const comparison = (pair) => h('section.panel',
    h('div.panel-head',
      h('div',
        h('h2.panel-title', 'Possible duplicate'),
        h('div.t-xs.subtle', { style: { marginTop: '2px' } },
          `#${pair.left.bitrixLeadId} and #${pair.right.bitrixLeadId} share a contact detail`)),
      h('div', { style: { minWidth: '160px' } },
        h('div.eyebrow', { style: { marginBottom: '4px', textAlign: 'right' } }, 'Signal match'),
        confidence(pair.similarity))),

    h('div.panel-body',
      h('div.compare', side(pair.left, pair.right), side(pair.right, pair.left)),

      // The PRD is explicit that this case is expected, not a defect.
      !pair.sameOwner
        ? h('div', { style: { marginTop: 'var(--sp-4)' } },
            banner('info', h('div',
              h('div.fw-medium', 'Different owners — two separate leads is correct'),
              h('div.t-xs', { style: { marginTop: '2px' } },
                'Each manager keeps the lead they brought in, so these are intentionally not merged.'))))
        : null,

      h('div', { style: { marginTop: 'var(--sp-5)' } },
        h('div.eyebrow', { style: { marginBottom: 'var(--sp-2)' } }, 'Matching signals'),
        h('div.grid.grid-2', { style: { gap: '0 var(--sp-6)' } },
          pair.signals.map((s) => h(`div.signal.${s.match ? 'yes' : 'no'}`,
            h('span.mark', s.match ? '✓' : '✕'), s.label)))),

      h('div.row', { style: { marginTop: 'var(--sp-5)', gap: 'var(--sp-3)' } },
        h('a.btn', { href: pair.left.url, target: '_blank', rel: 'noopener' },
          'Resolve in Bitrix24', icon('external', 13)),
        h('span.t-xs.subtle', { style: { marginLeft: 'auto' } },
          'Merging is done in the CRM, where its effect on both records is visible.'))),
  );

  replace(root, head, h('div.col', { style: { gap: 'var(--sp-6)' } }, pairs.map(comparison)));
}
