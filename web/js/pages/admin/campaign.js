/**
 * Campaign (admin) — the constants stamped on every lead, and the reference
 * lists they map onto.
 *
 * Read-only on purpose: these values come from the service's environment and
 * from Bitrix24 itself, so editing them here would give a false impression of
 * control. The screen shows what is in force and where to change it.
 */

import { h, replace } from '../../ui/dom.js';
import { panel, badge, apiErrorState, banner } from '../../ui/primitives.js';
import { getReference, getSystem } from '../../api.js';

const FIELD_TITLES = {
  UF_CRM_LEAD_TYPE: 'Lead type',
  UF_CRM_REGION: 'Region',
  UF_CRM_EXHIBITION: 'Exhibition',
  UF_CRM_PRODUCT_INTEREST: 'Product interest',
  UF_CRM_PRIORITY: 'Priority',
};

export async function renderCampaign(root) {
  let ref, sys;
  try {
    [ref, sys] = await Promise.all([getReference(), getSystem()]);
  } catch (err) {
    replace(root, apiErrorState(err, () => renderCampaign(root)));
    return;
  }

  const campaign = sys.campaign || ref.campaign || {};
  const tuning = sys.tuning || {};

  replace(root,
    h('div.page-head',
      h('div',
        h('h1.page-title', 'Campaign'),
        h('p.page-subtitle', 'Applied to every lead this service creates'))),

    banner('info',
      h('div',
        h('div.fw-medium', 'Configured in the service environment'),
        h('div.t-xs', { style: { marginTop: '2px' } },
          'These values come from the running service and from Bitrix24. Change them in the service configuration or in the CRM, then reload.'))),

    h('div.grid.grid-2', { style: { marginTop: 'var(--sp-4)', alignItems: 'start' } },
      panel({
        title: 'Identity',
        body: h('dl.dl',
          h('dt', 'Exhibition'), h('dd.fw-medium', campaign.exhibition || '—'),
          h('dt', 'Source'), h('dd', campaign.source || '—')),
      }),
      panel({
        title: 'Processing rules',
        body: h('dl.dl',
          h('dt', 'Confidence threshold'),
          h('dd', tuning.confidenceThreshold != null ? `${Math.round(tuning.confidenceThreshold * 100)}%` : '—'),
          h('dt', 'Grouping idle timeout'),
          h('dd', tuning.idleTimeoutMs ? `${Math.round(tuning.idleTimeoutMs / 60000)} min` : '—'),
          h('dt', 'Maximum session'),
          h('dd', tuning.maxSessionDurationMs ? `${Math.round(tuning.maxSessionDurationMs / 60000)} min` : '—'),
          h('dt', 'Poll interval'),
          h('dd', tuning.pollIntervalMs ? `${Math.round(tuning.pollIntervalMs / 1000)} s` : '—'),
          h('dt', 'Default owner'),
          h('dd', tuning.defaultOwnerId != null ? (ref.users?.[String(tuning.defaultOwnerId)] || `#${tuning.defaultOwnerId}`) : '—')),
      }),
    ),

    h('div', { style: { marginTop: 'var(--sp-4)' } },
      panel({
        title: 'Reference lists',
        subtitle: 'Read live from Bitrix24 — extracted text is matched to these labels, never to raw IDs',
        body: Object.keys(ref.lists || {}).length
          ? h('div.col', { style: { gap: 'var(--sp-5)' } },
              Object.entries(ref.lists).map(([code, options]) => h('div',
                h('div.eyebrow', { style: { marginBottom: 'var(--sp-2)' } }, FIELD_TITLES[code] || code),
                h('div.row.wrap', { style: { gap: '6px' } },
                  Object.values(options).map((label) => badge(label, 'neutral'))))))
          : h('p.t-sm.faint', 'No list fields were returned by the portal.'),
      })),
  );
}
