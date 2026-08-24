/**
 * Teams channel mapping (admin only):  channel → campaign → CRM configuration.
 */

import { h, replace, fmtAgo, fmtNum } from '../../ui/dom.js';
import { panel, badge, toast, emptyState } from '../../ui/primitives.js';
import { getChannels, getCampaign } from '../../api.js';

export async function renderChannels(root) {
  const [{ data: channels }, { data: campaign }] = await Promise.all([getChannels(), getCampaign()]);

  const row = (ch) => {
    let active = ch.active;
    const sw = h('button.switch' + (active ? '.is-on' : ''), {
      role: 'switch', 'aria-checked': String(active), 'aria-label': `${ch.channel} active`,
      onclick: () => {
        active = !active;
        sw.classList.toggle('is-on', active);
        sw.setAttribute('aria-checked', String(active));
        state.replaceChildren(active ? badge('Active', 'ok') : badge('Paused', 'neutral'));
        toast(`${ch.channel} ${active ? 'resumed' : 'paused'}`);
      },
    });
    const state = h('span', active ? badge('Active', 'ok') : badge('Paused', 'neutral'));

    return h('div.health-row',
      h('div.grow',
        h('div.row', { style: { gap: 'var(--sp-2)' } },
          h('span.fw-medium.mono', ch.channel),
          state),
        h('div.t-xs.subtle', { style: { marginTop: '2px' } },
          `${ch.team} → ${ch.campaign}`)),
      h('div.t-xs.subtle', { style: { textAlign: 'right', minWidth: '140px' } },
        h('div', `${fmtNum(ch.messages)} messages`),
        h('div', ch.lastMessageAt ? `last ${fmtAgo(ch.lastMessageAt)}` : 'no messages yet')),
      sw,
    );
  };

  replace(root,
    h('div.page-head',
      h('div',
        h('h1.page-title', 'Teams channels'),
        h('p.page-subtitle', 'Each channel feeds one campaign and its CRM configuration')),
      h('div.row',
        h('button.btn.btn-primary', { onclick: () => toast('Channel mapping is configured by an administrator') },
          'Add channel'))),

    panel({
      title: 'Mapped channels',
      subtitle: `Messages posted in these channels become leads in ${campaign.exhibition}`,
      flush: true,
      body: channels.length
        ? h('div', channels.map(row))
        : emptyState({ title: 'No channels mapped', note: 'Map a Teams channel to start ingesting messages.' }),
    }),

    h('div', { style: { marginTop: 'var(--sp-4)' } },
      panel({
        title: 'How mapping works',
        body: h('div.grid.grid-3',
          h('div',
            h('div.eyebrow', 'Teams channel'),
            h('p.t-sm.muted', { style: { marginTop: '6px' } },
              'Managers post free-form text, photos and voice notes. Nothing about their workflow changes.')),
          h('div',
            h('div.eyebrow', 'Campaign'),
            h('p.t-sm.muted', { style: { marginTop: '6px' } },
              'Fixes the exhibition and source stamped on every lead created from that channel.')),
          h('div',
            h('div.eyebrow', 'CRM configuration'),
            h('p.t-sm.muted', { style: { marginTop: '6px' } },
              'Determines the Bitrix24 pipeline, default owner and reference lists used for mapping.'))),
      })),
  );
}
