/**
 * Integrations and Diagnostics (admin).
 *
 * Reports the service's actual configuration and queue state. Credentials are
 * never rendered — only whether one is present — and there are no stack traces.
 */

import { h, icon, replace, fmtNum, fmtDateTime } from '../../ui/dom.js';
import { panel, badge, banner, metric, apiErrorState } from '../../ui/primitives.js';
import { getSystem, getReference } from '../../api.js';

/** A dependency's state derived from the service's own configuration. */
function integrations(sys) {
  const m = sys.modes || {};
  const c = sys.credentials || {};
  const p = sys.providers || {};
  return [
    {
      name: 'Microsoft Graph (Teams)',
      ok: m.msgraph === 'live' && c.graph,
      detail: m.msgraph === 'live' ? 'App-only · polling channel messages' : 'Not enabled',
      warn: 'Attachment files and reply posting need additional tenant permissions; inline images are read today.',
    },
    {
      name: 'Bitrix24 REST',
      ok: m.bitrix === 'live' && c.bitrixWebhook,
      detail: c.bitrixWebhook ? 'Inbound webhook · CRM scope' : 'No webhook configured',
    },
    {
      name: 'LLM extraction',
      ok: m.llm === 'live' && (p.llm === 'gemini' ? c.gemini : c.deepseek),
      detail: m.llm === 'live' ? `${p.llm} · ${p.model || ''}`.trim() : 'Mock mode',
    },
    {
      name: 'OCR (business cards)',
      ok: m.ocr === 'live' && (p.ocr === 'gemini' ? c.gemini : c.deepseek),
      detail: m.ocr === 'live' ? `${p.ocr} vision` : 'Fixture mode',
    },
    {
      name: 'Speech-to-text',
      ok: false,
      detail: m.asr === 'live' ? 'Provider configured' : 'Not configured — voice notes use supplied transcripts',
    },
  ];
}

export async function renderIntegrations(root) {
  let sys;
  try {
    sys = await getSystem();
  } catch (err) {
    replace(root, apiErrorState(err, () => renderIntegrations(root)));
    return;
  }

  replace(root,
    h('div.page-head',
      h('div',
        h('h1.page-title', 'Integrations'),
        h('p.page-subtitle', 'External services this platform depends on'))),

    banner('info',
      h('div',
        h('div.fw-medium', 'Credentials are never displayed'),
        h('div.t-xs', { style: { marginTop: '2px' } },
          'Secrets live only in the service environment. This screen reports whether one is configured, nothing more.'))),

    h('div.grid.grid-2', { style: { marginTop: 'var(--sp-4)', alignItems: 'start' } },
      integrations(sys).map((i) => h('section.panel',
        h('div.panel-head',
          h('div',
            h('h2.panel-title', i.name),
            h('div.t-xs.subtle', { style: { marginTop: '2px' } }, i.detail)),
          i.ok ? badge('Connected', 'ok') : badge('Not active', 'neutral')),
        i.warn && i.ok ? h('div.panel-body', banner('warn', h('div.t-sm', i.warn))) : null))),
  );
}

export async function renderDiagnostics(root) {
  let sys, ref;
  try {
    [sys, ref] = await Promise.all([getSystem(), getReference().catch(() => ({}))]);
  } catch (err) {
    replace(root, apiErrorState(err, () => renderDiagnostics(root)));
    return;
  }

  const q = sys.queues || {};
  const services = integrations(sys);
  const degraded = services.filter((s) => !s.ok);

  replace(root,
    h('div.page-head',
      h('div',
        h('h1.page-title', 'System health'),
        h('p.page-subtitle', 'Whether the pipeline can do its job right now')),
      h('div.row',
        h('button.btn', { onclick: () => renderDiagnostics(root) }, icon('refresh', 13), 'Refresh'))),

    h('div.grid.grid-3',
      metric({ label: 'Leads processed', value: fmtNum(q.processed ?? 0), note: 'written to Bitrix24' }),
      metric({
        label: 'Failed', value: fmtNum(q.failed ?? 0),
        note: q.failed ? 'available for resend' : 'none',
        tone: q.failed ? 'danger' : undefined,
      }),
      metric({
        label: 'Awaiting attachment', value: fmtNum(q.needsAttachmentRetry ?? 0),
        note: q.needsAttachmentRetry ? 'files not yet readable' : 'none',
        tone: q.needsAttachmentRetry ? 'warn' : undefined,
      }),
    ),

    degraded.length
      ? h('div', { style: { marginTop: 'var(--sp-4)' } },
          banner('warn',
            h('div',
              h('div.fw-medium', `${degraded.length} dependenc${degraded.length === 1 ? 'y is' : 'ies are'} not active`),
              h('div.t-xs', { style: { marginTop: '2px' } },
                'Leads are still created — the affected capability is deferred, not lost.'))))
      : null,

    h('div', { style: { marginTop: 'var(--sp-4)' } },
      panel({
        title: 'Dependencies',
        flush: true,
        body: h('div', services.map((s) => h('div.health-row',
          h('div.grow',
            h('div.t-sm.fw-medium', s.name),
            h('div.t-xs.subtle', { style: { marginTop: '2px' } }, s.detail)),
          s.ok ? badge('Operational', 'ok') : badge('Not active', 'neutral')))),
      })),

    h('div', { style: { marginTop: 'var(--sp-4)' } },
      panel({
        title: 'Ingestion',
        body: h('dl.dl',
          h('dt', 'Channel read up to'),
          h('dd', sys.watermark ? fmtDateTime(sys.watermark) : 'nothing read yet'),
          h('dt', 'Bitrix users known'),
          h('dd', fmtNum(Object.keys(ref.users || {}).length)),
          h('dt', 'Teams identities mapped'),
          h('dd', fmtNum((sys.employeeMap || []).length))),
      })),
  );
}
