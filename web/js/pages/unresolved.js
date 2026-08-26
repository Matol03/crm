/**
 * Needs attention — leads the pipeline flagged for a human.
 *
 * This is not a separate queue of invented "candidates": it is the real leads
 * our processing recorded a problem against — a failed CRM write, an attachment
 * it could not read, or a field it declined to fill. Each row links to the lead
 * itself so the operator can see the evidence and act.
 */

import { h, icon, replace, fmtDateTime } from '../ui/dom.js';
import { panel, badge, emptyState, apiErrorState, statusBadge, toast } from '../ui/primitives.js';
import { getAttention, resendLead } from '../api.js';
import { navigate } from '../router.js';

export async function renderUnresolved(root) {
  let items;
  try {
    items = await getAttention();
  } catch (err) {
    replace(root, apiErrorState(err, () => renderUnresolved(root)));
    return;
  }

  const head = h('div.page-head',
    h('div',
      h('h1.page-title', 'Needs attention'),
      h('p.page-subtitle', 'Leads the pipeline could not complete cleanly')),
    h('div.row', h('span.t-sm.subtle', `${items.length} item${items.length === 1 ? '' : 's'}`)));

  if (!items.length) {
    replace(root, head, panel({
      body: emptyState({
        tone: 'ok',
        title: 'Nothing needs attention',
        note: 'Every lead was processed without a warning, a failed write or an unread attachment.',
      }),
    }));
    return;
  }

  const card = (it) => {
    const retry = h('button.btn.btn-sm.btn-primary', {
      onclick: async () => {
        retry.disabled = true;
        replace(retry, h('span.spinner'), 'Retrying…');
        const res = await resendLead(it.localId);
        toast(res.message, res.ok ? 'ok' : 'danger');
        if (res.ok) renderUnresolved(root);
        else { retry.disabled = false; replace(retry, 'Retry'); }
      },
    }, icon('refresh', 12), 'Retry');

    return h('section.panel',
      h('div.panel-head',
        h('div',
          h('div.row', { style: { gap: 'var(--sp-2)' } },
            h('h2.panel-title', it.title || 'Untitled lead'),
            statusBadge(it.status),
            it.needsAttachmentRetry && badge('Attachment pending', 'warn')),
          h('div.t-xs.subtle', { style: { marginTop: '2px' } },
            it.bitrixLeadId ? `Lead #${it.bitrixLeadId}` : 'Not stored as a lead yet',
            ' · ', fmtDateTime(it.createdAt))),
        h('div.row',
          it.bitrixLeadId && h('button.btn.btn-sm', {
            onclick: () => navigate(`leads/${it.bitrixLeadId}`),
          }, 'Open lead'),
          it.status === 'failed' && retry)),

      h('div.panel-body',
        it.warnings.length
          ? h('ul.col', { style: { gap: '6px' } },
              it.warnings.map((w) => h('li.t-sm.muted', '• ' + w)))
          : h('p.t-sm.faint', 'No warnings recorded.')),
    );
  };

  replace(root, head, h('div.col', { style: { gap: 'var(--sp-4)' } }, items.map(card)));
}
