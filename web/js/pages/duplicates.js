/**
 * Duplicate review — leads in Bitrix24 that share a phone or email.
 *
 * Computed live from the portal rather than from a stored decision, so it always
 * reflects the CRM as it is now. Merging is not offered here: two managers
 * meeting the same visitor is a legitimate outcome, and a real merge belongs in
 * Bitrix24 itself, where its consequences are visible.
 */

import { h, icon, replace, fmtDateTime } from '../ui/dom.js';
import { panel, confidence, badge, emptyState, apiErrorState, banner, toast } from '../ui/primitives.js';
import { getDuplicates, mergeDuplicate, dismissDuplicate } from '../api.js';
import { navigate } from '../router.js';
import { isAdmin } from '../state.js';

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

      actionRow(pair)),
  );

  /**
   * Decisions a reviewer can take on a pair. "Not a duplicate" is available to
   * everyone, because it only records a judgement. Merging destroys one record
   * and removes its copy from the CRM, so it is an administrator action and is
   * confirmed first.
   */
  function actionRow(pair) {
    const busy = (btn, label) => { btn.disabled = true; btn.textContent = label; };

    const mergeInto = (survivor, other) => {
      const btn = h('button.btn.btn-sm', {
        onclick: async () => {
          const keep = survivor.name || `lead #${survivor.bitrixLeadId}`;
          const drop = other.name || `lead #${other.bitrixLeadId}`;
          if (!confirm(
            `Merge into “${keep}”?

` +
            `“${drop}” will be removed here and its copy deleted from Bitrix24. ` +
            `Details “${keep}” is missing will be copied across first.

This cannot be undone.`
          )) return;
          busy(btn, 'Merging…');
          try {
            await mergeDuplicate(pair.id, survivor.bitrixLeadId);
            toast(`Merged into ${keep}`, 'ok');
            renderDuplicates(root);
          } catch (err) {
            btn.disabled = false;
            btn.textContent = `Keep ${keep}`;
            toast(err?.message || 'The leads could not be merged.', 'warn');
          }
        },
      }, `Keep ${survivor.name || '#' + survivor.bitrixLeadId}`);
      return btn;
    };

    const dismiss = h('button.btn.btn-sm', {
      onclick: async () => {
        busy(dismiss, 'Saving…');
        try {
          await dismissDuplicate(pair.id);
          toast('Marked as different people', 'ok');
          renderDuplicates(root);
        } catch (err) {
          dismiss.disabled = false;
          dismiss.textContent = 'Not a duplicate';
          toast(err?.message || 'That could not be saved.', 'warn');
        }
      },
    }, 'Not a duplicate');

    return h('div.row.wrap', { style: { marginTop: 'var(--sp-5)', gap: 'var(--sp-3)' } },
      dismiss,
      isAdmin() ? mergeInto(pair.left, pair.right) : null,
      isAdmin() ? mergeInto(pair.right, pair.left) : null,
      h('span.t-xs.subtle', { style: { marginLeft: 'auto' } },
        isAdmin()
          ? 'Merging keeps one lead and copies across anything it was missing.'
          : 'Merging leads needs an administrator account.'));
  }

  replace(root, head, h('div.col', { style: { gap: 'var(--sp-6)' } }, pairs.map(comparison)));
}
