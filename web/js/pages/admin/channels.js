/**
 * Teams channel (admin) — which channel the service is actually polling, and
 * how far through it has read.
 *
 * There is one configured channel; this reports its real state rather than
 * presenting a list of channels the service does not watch.
 */

import { h, replace, fmtDateTime, fmtNum } from '../../ui/dom.js';
import { panel, badge, apiErrorState, banner } from '../../ui/primitives.js';
import { getSystem } from '../../api.js';

export async function renderChannels(root) {
  let sys;
  try {
    sys = await getSystem();
  } catch (err) {
    replace(root, apiErrorState(err, () => renderChannels(root)));
    return;
  }

  const ch = sys.channel || {};
  const live = sys.modes?.msgraph === 'live';

  replace(root,
    h('div.page-head',
      h('div',
        h('h1.page-title', 'Teams channel'),
        h('p.page-subtitle', 'The source this service ingests from'))),

    panel({
      title: 'Configured channel',
      actions: [live ? badge('Polling', 'ok') : badge('Not polling', 'neutral')],
      body: h('dl.dl',
        h('dt', 'Team id'), h('dd.mono.t-xs', ch.teamsGroupId || '—'),
        h('dt', 'Channel id'), h('dd.mono.t-xs', ch.channelId || '—'),
        h('dt', 'Poll interval'),
        h('dd', sys.tuning?.pollIntervalMs ? `${Math.round(sys.tuning.pollIntervalMs / 1000)} s` : '—'),
        h('dt', 'Read up to'),
        h('dd', sys.watermark ? fmtDateTime(sys.watermark) : 'nothing read yet')),
    }),

    h('div', { style: { marginTop: 'var(--sp-4)' } },
      panel({
        title: 'Processing so far',
        body: h('div.grid.grid-3',
          h('div', h('div.t-xs.subtle', 'Leads processed'),
            h('div.metric-value.sm', fmtNum(sys.queues?.processed ?? 0))),
          h('div', h('div.t-xs.subtle', 'Failed'),
            h('div.metric-value.sm', fmtNum(sys.queues?.failed ?? 0))),
          h('div', h('div.t-xs.subtle', 'Awaiting attachment'),
            h('div.metric-value.sm', fmtNum(sys.queues?.needsAttachmentRetry ?? 0)))),
      })),

    h('div', { style: { marginTop: 'var(--sp-4)' } },
      banner('info',
        h('div',
          h('div.fw-medium', 'How the mapping works'),
          h('div.t-xs', { style: { marginTop: '2px' } },
            'Messages posted in this channel become leads stamped with the campaign’s source. '
            + 'The manager who posted owns the lead. Changing the channel is a service configuration change.')))),
  );
}
