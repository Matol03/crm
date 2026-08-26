/**
 * Lead detail — the most important screen in the product.
 *
 * It answers, on one page: what did the system extract, how sure is it, which
 * raw message did each value come from, how were the messages grouped, and did
 * Bitrix24 accept the result.
 *
 * The defining interaction is the field → evidence link: selecting an extracted
 * field highlights and scrolls to the exact source message it was read from.
 */

import { h, icon, replace, fmtTime, fmtDateTime, humanize } from '../ui/dom.js';
import {
  panel, statusBadge, badge, confidence, lowConfidenceFlag,
  skeleton, errorState, apiErrorState, banner, toast,
} from '../ui/primitives.js';
import { getLead, resendLead, setLeadStatus, deleteLead, LEAD_STATUSES, FIELD_LABELS } from '../api.js';
import { navigate } from '../router.js';
import { isAdmin } from '../state.js';

const PRIORITY_TONE = { High: 'danger', Medium: 'warn', Low: 'neutral' };
const KIND = {
  voice: { icon: 'mic', label: 'Voice message' },
  image: { icon: 'camera', label: 'Business card' },
  text:  { icon: 'message', label: 'Text message' },
};

/** Field values shown in the extracted-data panel, in display order. */
function fieldRows(lead) {
  const first = (arr) => (arr && arr.length ? arr[0].value : null);
  return [
    ['name', lead.person?.name],
    ['company', lead.company],
    ['position', lead.person?.position],
    ['phone', first(lead.phones)],
    ['email', first(lead.emails)],
    ['country', lead.country],
    ['productInterest', lead.productInterest],
    ['priority', lead.priority],
  ];
}

export async function renderLeadDetail(root, id) {
  replace(root, h('div.stack-4', skeleton(2), panel({ body: skeleton(6) })));

  let lead;
  try {
    lead = await getLead(id);
  } catch (err) {
    replace(root, apiErrorState(err, () => navigate('leads')));
    return;
  }
  if (!lead) {
    replace(root, errorState({
      title: 'Lead not found',
      note: 'It may have been removed, or the identifier is out of date.',
      retry: () => navigate('leads'),
    }));
    return;
  }
  /** Currently selected field key — drives the evidence highlight. */
  let selected = null;

  const evidenceHost = h('div.stack-4');
  const fieldsHost = h('div');

  /* ── Evidence panel ──────────────────────────────────────────────────
     One block per source message, in chronological order. When a field is
     selected, the message it came from is highlighted and scrolled into view.
     ------------------------------------------------------------------- */

  function renderEvidence() {
    const linkedMessageId = selected ? lead.provenance?.[selected]?.messageId : null;

    replace(evidenceHost,
      h('div.eyebrow', { style: { marginBottom: 'var(--sp-3)' } },
        `Source · ${lead.sourceMessages.length} message${lead.sourceMessages.length === 1 ? '' : 's'} grouped into this lead`),

      selected && lead.provenance?.[selected] && h('div.banner.banner-info', { style: { marginBottom: 'var(--sp-3)' } },
        icon('search', 15),
        h('div.grow',
          h('div.fw-medium', `${FIELD_LABELS[selected]} came from this message`),
          lead.provenance[selected].note && h('div.t-xs', { style: { marginTop: '2px' } }, lead.provenance[selected].note))),

      lead.sourceMessages.length
        ? h('div.timeline', lead.sourceMessages.map((m) => messageBlock(m, m.id === linkedMessageId)))
        : h('p.t-sm.subtle', 'No source messages were stored for this lead.'),
    );

    if (linkedMessageId) {
      const el = evidenceHost.querySelector(`[data-msg="${CSS.escape(linkedMessageId)}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  /** Collapsed raw OCR text — the exact characters read from the card. */
  function ocrToggle(text) {
    if (!text) return null;
    const body = h('div.evidence-quote', { style: { display: 'none', marginTop: 'var(--sp-2)' } }, text);
    const btn = h('button.btn.btn-ghost.btn-sm', {
      style: { marginTop: 'var(--sp-2)' },
      onclick: () => {
        const open = body.style.display !== 'none';
        body.style.display = open ? 'none' : 'block';
        btn.lastChild.textContent = open ? 'Show OCR text' : 'Hide OCR text';
      },
    }, icon('search', 12), h('span', 'Show OCR text'));
    return h('div', btn, body);
  }

  function messageBlock(m, linked) {
    const kind = KIND[m.type] || KIND.text;
    const quote = m.type === 'voice' ? m.transcript : m.type === 'image' ? m.ocrText : m.text;

    return h('div.tl-item',
      h('div.tl-dot' + (linked ? '.info' : ''), icon(kind.icon, 9)),
      h('div.tl-time', fmtTime(m.ts)),
      h('div.tl-title', kind.label, m.durationSec ? h('span.subtle.t-xs', ` · ${m.durationSec}s`) : null),
      h('div.tl-body',
        h('div.evidence' + (linked ? '.is-linked' : ''), { dataset: { msg: m.id } },
          h('div.evidence-head',
            icon(kind.icon, 12),
            m.author || 'Manager',
            h('span.right.t-xs', fmtTime(m.ts))),

          // A business card is shown as a rendered card, not a raw blob.
          m.type === 'image' && m.card
            ? h('div.card-thumb',
                h('div.ct-name', m.card.name),
                m.card.position && h('div.subtle', m.card.position),
                h('div.ct-rule'),
                m.card.company && h('div.fw-medium', m.card.company),
                m.card.email && h('div.mono', m.card.email),
                m.card.phone && h('div.mono', m.card.phone),
                m.card.address && h('div.subtle', m.card.address))
            : null,

          m.attachmentPending
            ? h('div.t-sm.subtle', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
                h('span.spinner'), 'Attachment not yet retrievable — queued for retry')
            : m.type === 'image' && m.card
              // The card is already rendered above; the raw OCR text is the
              // machine's reading of it, so it is available but not duplicated.
              ? ocrToggle(quote)
              : quote
                ? h('div.evidence-quote', quote)
                : h('div.t-sm.faint', 'No readable content'),

          m.type === 'voice' && h('div.row', { style: { marginTop: 'var(--sp-2)' } },
            h('button.btn.btn-sm', { onclick: () => toast('Audio playback is not wired in this build') },
              icon('play', 12), 'Play'),
            h('span.t-xs.subtle', 'Original recording preserved')),
        )),
    );
  }

  /* ── Extracted fields ────────────────────────────────────────────────── */

  function renderFields() {
    const rows = fieldRows(lead);
    replace(fieldsHost,
      rows.map(([key, value]) => {
        const score = lead.confidence?.fields?.[key];
        const hasSource = !!lead.provenance?.[key];
        const isEmpty = value == null || value === '';
        const low = score != null && score < 0.75;

        return h('div.field-row'
          + (selected === key ? '.is-selected' : '')
          + (isEmpty || !hasSource ? '.is-empty' : ''), {
          tabindex: isEmpty || !hasSource ? null : 0,
          title: hasSource ? 'Show where this value came from' : null,
          onclick: isEmpty || !hasSource ? null : () => {
            selected = selected === key ? null : key;
            renderFields();
            renderEvidence();
          },
          onkeydown: (e) => {
            if ((e.key === 'Enter' || e.key === ' ') && hasSource && !isEmpty) {
              e.preventDefault();
              selected = selected === key ? null : key;
              renderFields(); renderEvidence();
            }
          },
        },
          h('div.field-name', FIELD_LABELS[key]),
          h('div',
            isEmpty
              ? h('div.field-value.not-detected', 'Not detected')
              : h('div.field-value', value),
            low && !isEmpty && lowConfidenceFlag(
              key === 'email' ? 'Low confidence — verify before outreach' : 'Low confidence'),
            hasSource && !isEmpty && h('div.t-xs.subtle', { style: { marginTop: '2px', display: 'flex', gap: '5px', alignItems: 'center' } },
              icon(KIND[sourceKind(key)]?.icon || 'message', 11),
              sourceLabel(key))),
          // No value means there is nothing to be confident about — showing a
          // 0% bar for an undetected field reads as a failure rather than a blank.
          h('div', isEmpty
            ? h('span.t-xs.faint', '—')
            : score == null
              ? h('span.t-xs.faint', lead.fromPipeline ? 'not recorded' : '—')
              : confidence(score)),
        );
      }),
    );
  }

  const sourceKind = (key) => {
    const p = lead.provenance?.[key];
    const msg = lead.sourceMessages.find((m) => m.id === p?.messageId);
    return msg?.type || 'text';
  };
  const sourceLabel = (key) => {
    const p = lead.provenance?.[key];
    const msg = lead.sourceMessages.find((m) => m.id === p?.messageId);
    return msg ? `${KIND[msg.type]?.label || 'Message'} · ${fmtTime(msg.ts)}` : 'Source recorded';
  };

  /* ── CRM status / retry ──────────────────────────────────────────────── */

  /** Mirror failure is shown, never hidden — the lead is safe locally. */
  function mirrorWarning() {
    const m = lead.crm?.mirror;
    if (!m?.error) return null;
    return h('div.banner.banner-warn',
      icon('alert', 15),
      h('div.grow',
        h('div.fw-medium', 'Not copied to Bitrix24'),
        h('div.t-xs', { style: { marginTop: '2px' } },
          'This lead is saved here and is not lost. The copy to Bitrix24 failed: ' + m.error)));
  }

  function crmSection() {
    const crm = lead.crm || {};
    if (crm.state === 'created') {
      // With the platform sink the lead lives here, and `url` is an in-app
      // route — an "open externally" button would just reload this page.
      const external = crm.url && !String(crm.url).startsWith('#');
      return h('div.banner.banner-ok',
        icon('check', 15),
        h('div.grow',
          h('div.fw-medium', external
            ? `In Bitrix24 · Lead #${crm.bitrixLeadId}`
            : `Lead #${crm.bitrixLeadId} · stored on this platform`),
          h('div.t-xs', { style: { marginTop: '2px' } },
            `Owner ${lead.owner?.name || '—'} · ${lead.statusLabel || ''}`,
            lead.fromPipeline ? ' · created from Teams' : ' · added directly')),
        external && h('a.btn.btn-sm', { href: crm.url, target: '_blank', rel: 'noopener' },
          'Open in Bitrix', icon('external', 12)),
        // Mirrored to the portal as well — offer the outbound link, or say
        // plainly that the copy did not make it.
        !external && crm.mirror?.url && h('a.btn.btn-sm',
          { href: crm.mirror.url, target: '_blank', rel: 'noopener' },
          `Also in Bitrix #${crm.mirror.leadId}`, icon('external', 12)));
    }
    if (crm.state === 'failed') {
      const btn = h('button.btn.btn-primary.btn-sm', {
        onclick: async () => {
          btn.disabled = true;
          replace(btn, h('span.spinner'), 'Retrying…');
          const res = await resendLead(lead.localId ?? lead.id);
          if (res.ok) {
            toast(res.message, 'ok');
            renderLeadDetail(root, id);
          } else {
            btn.disabled = false;
            replace(btn, 'Retry now');
            toast('Retry failed — try again shortly', 'danger');
          }
        },
      }, icon('refresh', 13), 'Retry now');

      return h('div.banner.banner-danger',
        icon('alert', 15),
        h('div.grow',
          h('div.fw-medium', 'CRM sync failed'),
          h('div.t-sm', { style: { marginTop: '2px' } }, crm.error || 'The lead could not be written to Bitrix24.'),
          h('div.t-xs', { style: { marginTop: '4px' } },
            crm.retryable ? 'Status: retryable' : 'Status: needs attention',
            crm.lastAttempt ? ` · last attempt ${fmtDateTime(crm.lastAttempt)}` : '',
            crm.attempts ? ` · ${crm.attempts} attempts` : ''),
          h('div', { style: { marginTop: 'var(--sp-3)' } }, btn)));
    }
    return banner('info', h('div.fw-medium', 'Awaiting CRM sync'),
      h('div.t-xs', { style: { marginTop: '2px' } }, 'The lead is queued for delivery to Bitrix24.'));
  }

  /* ── Processing journal (collapsible; fuller for admins) ─────────────── */

  function journalSection() {
    const entries = isAdmin() ? lead.journal : lead.journal.filter((e) => e.tone === 'ok' || e.tone === 'danger');
    if (!entries.length) return null;

    const body = h('div.timeline', { style: { display: 'none' } },
      entries.map((e) => h('div.tl-item',
        h(`div.tl-dot.${e.tone || 'info'}`, icon(e.tone === 'ok' ? 'check' : e.tone === 'danger' ? 'alert' : 'clock', 9)),
        h('div.tl-time', fmtTime(e.ts)),
        h('div.tl-title', e.label),
        e.detail && h('div.t-xs.subtle', e.detail))));

    const chevron = icon('chevronRight', 14);
    const toggle = h('button.btn.btn-ghost.btn-sm', {
      onclick: () => {
        const open = body.style.display !== 'none';
        body.style.display = open ? 'none' : 'block';
        chevron.style.transform = open ? '' : 'rotate(90deg)';
        toggle.lastChild.textContent = open ? 'Show' : 'Hide';
      },
    }, chevron, h('span', 'Show'));

    return panel({
      title: 'Processing journal',
      subtitle: isAdmin() ? 'Every decision the pipeline made' : 'Key milestones',
      actions: [toggle],
      body,
    });
  }

  /**
   * Move the lead along its funnel. One click per step, with the current stage
   * shown as selected — quicker and less error-prone than a dropdown for four
   * options, and it makes the whole path visible at a glance.
   */
  function statusControl() {
    const current = lead.statusId || 'NEW';
    let busy = false;

    const buttons = LEAD_STATUSES.map((st) => {
      const active = st.id === current;
      const btn = h(
        `button.btn.btn-sm${active ? '.btn-primary' : ''}`,
        {
          disabled: active,
          title: active ? 'Current stage' : `Move to “${st.label}”`,
          onclick: async () => {
            if (busy) return;
            busy = true;
            const previous = btn.textContent;
            btn.textContent = 'Saving…';
            try {
              await setLeadStatus(lead.bitrixLeadId, st.id);
              toast(`Moved to “${st.label}”`);
              // Re-render from the service so what is shown is what was stored.
              renderLeadDetail(root, String(lead.bitrixLeadId));
            } catch (err) {
              btn.textContent = previous;
              busy = false;
              toast(err?.message || 'The status could not be saved.', 'warn');
            }
          },
        },
        st.label,
      );
      return btn;
    });

    return panel({
      title: 'Stage',
      subtitle: 'Where this lead stands. Changing it here updates the record.',
      body: h('div.row.wrap', { style: { gap: 'var(--sp-2)', padding: 'var(--sp-3)' } }, ...buttons),
    });
  }

  /**
   * Removing a lead. Administrator only, confirmed, and explicit that the copy
   * in Bitrix24 goes too — a lead deleted here but left in the CRM would still
   * be worked by the sales team.
   */
  function deleteControl() {
    if (!isAdmin()) return null;
    const btn = h('button.btn.btn-sm', {
      style: { color: 'var(--danger, #D14338)' },
      onclick: async () => {
        const who = lead.person?.name || `lead #${lead.bitrixLeadId}`;
        if (!confirm(
          `Delete “${who}”?

` +
          `It will be removed from this platform and its copy deleted from Bitrix24.

` +
          `This cannot be undone.`
        )) return;
        btn.disabled = true;
        btn.textContent = 'Deleting…';
        try {
          await deleteLead(lead.bitrixLeadId);
          toast(`Deleted “${who}”`, 'ok');
          navigate('leads');
        } catch (err) {
          btn.disabled = false;
          btn.textContent = 'Delete lead';
          toast(err?.message || 'The lead could not be deleted.', 'warn');
        }
      },
    }, 'Delete lead');

    return panel({
      title: 'Remove this lead',
      subtitle: 'Deletes it here and in Bitrix24. Rejecting it instead keeps the record here.',
      body: h('div', { style: { padding: 'var(--sp-3)' } }, btn),
    });
  }

  /* ── Compose ─────────────────────────────────────────────────────────── */

  renderFields();
  renderEvidence();

  const overall = lead.confidence?.overall;

  replace(root,
    h('div', { style: { marginBottom: 'var(--sp-4)' } },
      h('button.btn.btn-ghost.btn-sm', { onclick: () => navigate('leads') },
        icon('arrowLeft', 14), 'Back to Leads')),

    // ── Header ────────────────────────────────────────────────────────
    h('div.page-head',
      h('div',
        h('h1.page-title', lead.person?.name || 'Unnamed lead'),
        h('p.page-subtitle',
          [lead.company, lead.person?.position].filter(Boolean).join(' · ') || 'No company recorded'),
        h('div.row.wrap', { style: { marginTop: 'var(--sp-3)', gap: 'var(--sp-2)' } },
          lead.leadType && badge(lead.leadType, /partner/i.test(lead.leadType) ? 'purple' : 'neutral', { large: true }),
          lead.priority && badge(`${lead.priority} priority`, PRIORITY_TONE[lead.priority] || 'neutral', { large: true }),
          statusBadge(lead.status, { large: true, label: lead.statusLabel }),
          lead.bitrixLeadId && badge(`Lead #${lead.bitrixLeadId}`, 'ok', { large: true }),
          lead.needsAttachmentRetry && badge('Attachment pending', 'warn', { large: true }))),
      h('div', { style: { minWidth: '220px' } },
        h('div.eyebrow', { style: { marginBottom: '6px' } }, 'Overall confidence'),
        overall == null
          ? h('div.t-sm.faint', 'Not recorded by the service')
          : confidence(overall, { size: 'lg' }))),

    !lead.fromPipeline
      ? h('div', { style: { marginBottom: 'var(--sp-4)' } },
          banner('info',
            h('div.fw-medium', 'This lead was not created by the pipeline'),
            h('div.t-xs', { style: { marginTop: '2px' } },
              'It was added directly, so there are no source messages, confidence scores or evidence to show.')))
      : null,

    lead.warnings?.length
      ? h('div', { style: { marginBottom: 'var(--sp-4)' } },
          banner('warn',
            h('div.fw-medium', `${lead.warnings.length} note${lead.warnings.length === 1 ? '' : 's'} from processing`),
            h('ul', { style: { marginTop: '4px' } }, lead.warnings.map((w) => h('li.t-sm', '• ' + w)))))
      : null,

    h('div', { style: { marginBottom: 'var(--sp-4)' } }, crmSection(), mirrorWarning()),

    lead.bitrixLeadId && h('div', { style: { marginBottom: 'var(--sp-4)' } }, statusControl()),

    lead.bitrixLeadId && deleteControl() && h('div', { style: { marginBottom: 'var(--sp-4)' } }, deleteControl()),

    // ── Extracted data + evidence, side by side ───────────────────────
    h('div.grid', { style: { gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', alignItems: 'start' } },
      panel({
        title: 'Extracted data',
        subtitle: 'Select a field to reveal the message it came from',
        flush: true,
        body: fieldsHost,
      }),
      panel({ body: evidenceHost }),
    ),

    // ── Original input vs AI summary — never conflated ────────────────
    h('div.grid.grid-2', { style: { marginTop: 'var(--sp-4)', alignItems: 'start' } },
      panel({
        title: 'Original input',
        subtitle: 'Exactly what the manager said or typed — preserved verbatim',
        body: lead.verbatim
          ? h('div.evidence', h('div.evidence-quote', lead.verbatim))
          : h('p.t-sm.faint', 'No verbatim text stored.'),
      }),
      panel({
        title: 'AI summary',
        subtitle: 'Generated analysis — not a transcript',
        actions: [badge('Generated', 'purple')],
        body: lead.aiSummary
          ? h('p.t-sm', lead.aiSummary)
          : h('p.t-sm.faint', 'No summary generated.'),
      }),
    ),

    h('div', { style: { marginTop: 'var(--sp-4)' } }, journalSection()),
  );
}
