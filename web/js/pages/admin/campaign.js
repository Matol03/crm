/**
 * Campaign settings (admin only).
 *
 * These are the fixed values applied to every lead created during the period.
 * Bitrix's numeric list IDs are deliberately never shown — operators pick
 * labels, the service resolves the IDs.
 */

import { h, replace } from '../../ui/dom.js';
import { panel, badge, toast } from '../../ui/primitives.js';
import { getCampaign } from '../../api.js';

export async function renderCampaign(root) {
  const { data: c } = await getCampaign();
  let active = c.active;

  const toggle = h('button.switch' + (active ? '.is-on' : ''), {
    role: 'switch', 'aria-checked': String(active), 'aria-label': 'Campaign active',
    onclick: () => {
      active = !active;
      toggle.classList.toggle('is-on', active);
      toggle.setAttribute('aria-checked', String(active));
      statusBadgeHost.replaceChildren(active ? badge('Active', 'ok') : badge('Paused', 'neutral'));
    },
  });
  const statusBadgeHost = h('span', active ? badge('Active', 'ok') : badge('Paused', 'neutral'));

  const select = (label, options, value) => h('div',
    h('label.field-label', label),
    h('select.select', { style: { width: '100%' } },
      options.map((o) => h('option', { selected: o === value || null }, o))));

  replace(root,
    h('div.page-head',
      h('div',
        h('h1.page-title', 'Campaign'),
        h('p.page-subtitle', 'Applied to every lead created during this exhibition')),
      h('div.row',
        h('button.btn', { onclick: () => toast('Changes discarded') }, 'Discard'),
        h('button.btn.btn-primary', { onclick: () => toast('Campaign settings saved', 'ok') }, 'Save changes'))),

    h('div.grid', { style: { gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)', alignItems: 'start' } },
      panel({
        title: 'Identity',
        body: h('div.grid.grid-2',
          h('div',
            h('label.field-label', 'Exhibition'),
            h('input.input', { value: c.exhibition })),
          h('div',
            h('label.field-label', 'Source'),
            h('input.input', { value: c.source })),
          h('div',
            h('label.field-label', 'Starts'),
            h('input.input', { type: 'date', value: c.startsAt })),
          h('div',
            h('label.field-label', 'Ends'),
            h('input.input', { type: 'date', value: c.endsAt }))),
      }),

      panel({
        title: 'Status',
        body: h('div',
          h('div.between',
            h('div',
              h('div.t-sm.fw-medium', 'Accept new messages'),
              h('div.t-xs.subtle', { style: { marginTop: '2px' } },
                'When paused, messages are still stored but no leads are created.')),
            toggle),
          h('div', { style: { marginTop: 'var(--sp-4)' } }, statusBadgeHost)),
      }),
    ),

    h('div', { style: { marginTop: 'var(--sp-4)' } },
      panel({
        title: 'Defaults',
        subtitle: 'Used when the message does not clearly indicate a value',
        body: h('div.grid.grid-3',
          select('Lead type', c.leadTypes, 'Customer'),
          select('Priority', c.priorities, 'Medium'),
          select('Region', c.regions, 'Europe')),
      })),

    h('div', { style: { marginTop: 'var(--sp-4)' } },
      panel({
        title: 'Reference lists',
        subtitle: 'Synchronised from Bitrix24 — operators choose labels, never raw IDs',
        body: h('div.grid.grid-2',
          h('div',
            h('div.eyebrow', { style: { marginBottom: 'var(--sp-2)' } }, 'Product interests'),
            h('div.row.wrap', { style: { gap: '6px' } }, c.productInterests.map((p) => badge(p, 'neutral')))),
          h('div',
            h('div.eyebrow', { style: { marginBottom: 'var(--sp-2)' } }, 'Regions'),
            h('div.row.wrap', { style: { gap: '6px' } }, c.regions.map((r) => badge(r, 'neutral'))))),
      })),
  );
}
