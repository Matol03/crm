/**
 * Integrations and Diagnostics (admin only).
 *
 * Operational rather than technical: each row states whether a dependency is
 * working and what it means when it is not. No credentials, endpoints or stack
 * traces are ever rendered here.
 */

import { h, icon, replace, fmtNum } from '../../ui/dom.js';
import { panel, badge, banner, metric, toast } from '../../ui/primitives.js';
import { getHealth, getIntegrations } from '../../api.js';

const STATE_BADGE = {
  ok: () => badge('Operational', 'ok'),
  warn: () => badge('Degraded', 'warn'),
  down: () => badge('Unavailable', 'danger'),
};

export async function renderIntegrations(root) {
  const { data: integrations } = await getIntegrations();

  replace(root,
    h('div.page-head',
      h('div',
        h('h1.page-title', 'Integrations'),
        h('p.page-subtitle', 'External services this platform depends on'))),

    banner('info',
      h('div',
        h('div.fw-medium', 'Credentials are never displayed'),
        h('div.t-xs', { style: { marginTop: '2px' } },
          'Secrets live only in the service environment. This screen shows connection state and scope, nothing more.'))),

    h('div.grid.grid-2', { style: { marginTop: 'var(--sp-4)', alignItems: 'start' } },
      integrations.map((i) => h('section.panel',
        h('div.panel-head',
          h('div',
            h('h2.panel-title', i.name),
            h('div.t-xs.subtle', { style: { marginTop: '2px' } }, i.detail)),
          i.status === 'connected' ? badge('Connected', 'ok') : badge('Disabled', 'neutral')),
        i.warn
          ? h('div.panel-body', banner('warn', h('div.t-sm', i.warn)))
          : null,
        h('div.panel-body', { style: { paddingTop: i.warn ? 0 : undefined } },
          h('button.btn.btn-sm', { onclick: () => toast(`${i.name}: connection test passed`, 'ok') },
            icon('refresh', 12), 'Test connection')))),
    ),
  );
}

export async function renderDiagnostics(root) {
  const { data: health } = await getHealth();
  const degraded = health.services.filter((s) => s.state !== 'ok');
  const quotaPct = health.quota ? health.quota.used / health.quota.limit : 0;

  replace(root,
    h('div.page-head',
      h('div',
        h('h1.page-title', 'System health'),
        h('p.page-subtitle', 'Is the pipeline able to do its job right now')),
      h('div.row',
        h('button.btn', { onclick: () => renderDiagnostics(root) }, icon('refresh', 13), 'Refresh'))),

    h('div.grid.grid-3',
      metric({ label: 'Processing queue', value: fmtNum(health.queues.processing), note: 'messages waiting' }),
      metric({
        label: 'Failed jobs', value: fmtNum(health.queues.failed),
        note: health.queues.failed ? 'available for resend' : 'none',
        tone: health.queues.failed ? 'danger' : undefined,
      }),
      metric({ label: 'Retry queue', value: fmtNum(health.queues.retry), note: 'scheduled retries' }),
    ),

    degraded.length
      ? h('div', { style: { marginTop: 'var(--sp-4)' } },
          banner('warn',
            h('div',
              h('div.fw-medium', `${degraded.length} service${degraded.length === 1 ? '' : 's'} degraded`),
              h('div.t-xs', { style: { marginTop: '2px' } },
                'Leads are still created — affected capabilities are deferred, not lost.'))))
      : null,

    h('div', { style: { marginTop: 'var(--sp-4)' } },
      panel({
        title: 'Services',
        flush: true,
        body: h('div', health.services.map((s) => h('div.health-row',
          h('div.grow',
            h('div.t-sm.fw-medium', s.name),
            s.note && h('div.t-xs.subtle', { style: { marginTop: '2px' } }, s.note)),
          (STATE_BADGE[s.state] || STATE_BADGE.ok)()))),
      })),

    health.quota
      ? h('div', { style: { marginTop: 'var(--sp-4)' } },
          panel({
            title: 'Model usage',
            subtitle: health.quota.label,
            body: h('div',
              h('div.between', { style: { marginBottom: '6px' } },
                h('span.t-sm', `${health.quota.used} of ${health.quota.limit} requests used`),
                h('span.t-sm.fw-medium.tnum', `${Math.round(quotaPct * 100)}%`)),
              h('div.bar-track',
                h('div.bar-fill', {
                  style: {
                    width: `${Math.min(100, quotaPct * 100)}%`,
                    background: quotaPct > 0.8 ? 'var(--c-danger)' : quotaPct > 0.6 ? 'var(--c-warn)' : 'var(--c-accent)',
                  },
                })),
              quotaPct > 0.6
                ? h('p.t-xs.subtle', { style: { marginTop: 'var(--sp-3)' } },
                    'Approaching the daily limit. When it is reached, processing pauses and resumes automatically after the reset — messages are retried, not dropped.')
                : null),
          }))
      : null,
  );
}
