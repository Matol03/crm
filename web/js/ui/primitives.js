/**
 * Shared UI primitives: badges, confidence indicators, panels, metrics,
 * and the loading / empty / error states.
 *
 * Every screen composes these rather than styling one-off markup, so status
 * colour, confidence banding and spacing stay identical across the app.
 */

import { h, icon, fmtPct } from './dom.js';

/* ── Status ───────────────────────────────────────────────────────────────
   One table maps every lead/candidate status to its label, badge tone and
   whether it is "live". Adding a status = one entry here.
   ---------------------------------------------------------------------- */

export const STATUS = {
  created:     { label: 'Created',      tone: 'ok' },
  new:         { label: 'Unprocessed',  tone: 'info' },
  synced:      { label: 'Synced',       tone: 'ok' },
  done:        { label: 'Created',      tone: 'ok' },
  processing:  { label: 'Processing',   tone: 'info', live: true },
  writing_crm: { label: 'Syncing',      tone: 'info', live: true },
  received:    { label: 'Received',     tone: 'neutral' },
  segmented:   { label: 'Grouping',     tone: 'info', live: true },
  extracted:   { label: 'Extracted',    tone: 'info' },
  mapped:      { label: 'Mapped',       tone: 'info' },
  needs_review:{ label: 'Needs review', tone: 'warn' },
  review:      { label: 'Needs review', tone: 'warn' },
  duplicate:   { label: 'Duplicate',    tone: 'purple' },
  unresolved:  { label: 'Unresolved',   tone: 'warn' },
  failed:      { label: 'Failed',       tone: 'danger' },
  ignored:     { label: 'Ignored',      tone: 'neutral' },
  merged:      { label: 'Merged',       tone: 'purple' },
};

/** Status badge. Falls back to a neutral badge for unknown values. */
export function statusBadge(status, { large = false, label } = {}) {
  // Copy: STATUS is shared, so a label override must not mutate it.
  const meta = { ...(STATUS[status] || { label: status || 'Unknown', tone: 'neutral' }) };
  if (label) meta.label = label;
  return h(
    `span.badge.badge-${meta.tone}${large ? '.badge-lg' : ''}`,
    h('span.dot' + (meta.live ? '.live' : '')),
    meta.label,
  );
}

/** Generic badge. */
export function badge(text, tone = 'neutral', { large = false, title = null } = {}) {
  return h(`span.badge.badge-${tone}${large ? '.badge-lg' : ''}`, title ? { title } : null, text);
}

/* ── Confidence ─────────────────────────────────────────────────────────── */

/** Band a 0..1 score. Thresholds match the pipeline's 0.6 gate. */
export function confBand(score) {
  if (score >= 0.9) return 'high';
  if (score >= 0.75) return 'good';
  if (score >= 0.6) return 'mid';
  return 'low';
}

/**
 * Confidence bar + percentage.
 * `size: 'lg'` is used for the aggregate score in the lead-detail header.
 */
export function confidence(score, { size = 'sm', showValue = true } = {}) {
  if (score == null) {
    return h('span.conf-value.faint', '—');
  }
  const pct = Math.round(score * 100);
  return h(
    `div.conf.conf-${confBand(score)}${size === 'lg' ? '.conf-lg' : ''}`,
    h('div.conf-track', { role: 'meter', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 },
      h('div.conf-fill', { style: { width: `${pct}%` } })),
    showValue && h('span.conf-value', `${pct}%`),
  );
}

/** Small "⚠ Low confidence" note shown under a gated field. */
export function lowConfidenceFlag(text = 'Low confidence') {
  return h('div.field-flag', icon('alert', 12), text);
}

/* ── Layout ─────────────────────────────────────────────────────────────── */

export function panel({ title, subtitle, actions, body, flush = false, tight = false }) {
  const cls = `div.panel-body${flush ? '.flush' : ''}${tight ? '.tight' : ''}`;
  return h('section.panel',
    (title || actions) && h('header.panel-head',
      h('div',
        title && h('h2.panel-title', title),
        subtitle && h('div.t-xs.subtle', subtitle)),
      actions && h('div.row', actions)),
    body != null && h(cls, body),
  );
}

/** KPI tile. `delta` is rendered as a coloured secondary line when present. */
export function metric({ label, value, note, delta, deltaDir = 'up', tone }) {
  return h('div.panel.metric',
    h('div.metric-label', label),
    h('div.metric-value' + (tone ? '' : ''), { style: tone ? { color: `var(--c-${tone})` } : {} }, value),
    (note || delta) && h('div.metric-foot',
      delta && h('span.metric-delta.' + deltaDir, delta),
      delta && note ? ' ' : null,
      note),
  );
}

/* ── States ─────────────────────────────────────────────────────────────── */

/** Skeleton block; `lines` short bars of varying width. */
export function skeleton(lines = 3, { height = 10 } = {}) {
  const widths = ['92%', '76%', '84%', '64%', '88%'];
  return h('div', Array.from({ length: lines }, (_, i) =>
    h('div.skeleton.sk-line', { style: { width: widths[i % widths.length], height: `${height}px` } })));
}

/** Table-shaped skeleton so loading does not shift the layout. */
export function tableSkeleton(rows = 6) {
  return h('div', { style: { padding: 'var(--sp-5)' } },
    Array.from({ length: rows }, () =>
      h('div.row', { style: { gap: 'var(--sp-4)', padding: '6px 0' } },
        h('div.skeleton', { style: { width: '28%', height: '14px' } }),
        h('div.skeleton', { style: { width: '18%', height: '14px' } }),
        h('div.skeleton', { style: { width: '14%', height: '14px' } }),
        h('div.skeleton', { style: { flex: '1', height: '14px' } }))));
}

export function emptyState({ title, note, action, tone = '' }) {
  return h('div.state',
    h('div.state-icon' + (tone ? '.' + tone : ''), icon(tone === 'ok' ? 'check' : 'inbox', 18)),
    h('div.state-title', title),
    note && h('p.state-note', note),
    action && h('div', { style: { marginTop: 'var(--sp-3)' } }, action),
  );
}

/**
 * Error state. Deliberately explains what happened and what to do next —
 * never a raw stack trace or credential (PRD §14).
 */
export function errorState({ title = 'Something went wrong', note, retry }) {
  return h('div.state',
    h('div.state-icon.danger', icon('alert', 18)),
    h('div.state-title', title),
    note && h('p.state-note', note),
    retry && h('div', { style: { marginTop: 'var(--sp-3)' } },
      h('button.btn.btn-primary', { onclick: retry }, icon('refresh', 14), 'Try again')),
  );
}

/**
 * Turns an ApiError into an explanation the operator can act on. The three
 * cases mean very different things, so they must not collapse into one message.
 */
export function apiErrorState(err, retry) {
  const kind = err?.kind;
  if (kind === 'auth') {
    return emptyState({
      title: 'Connect to the lead service',
      note: 'This console reads live data from Bitrix24 through the service. Use the “Not connected” control in the header to enter the API secret.',
    });
  }
  if (kind === 'no-service') {
    return emptyState({
      title: 'No lead service behind this page',
      note: 'This is a static copy of the console. The service that polls Teams and reads Bitrix24 '
        + 'is a long-running process with its own database, so it cannot run on static hosting. '
        + 'Open the console from the machine running the service to see live data.',
    });
  }
  if (kind === 'crm') {
    return errorState({
      title: 'No Bitrix24 connection configured',
      note: err.message,
      retry,
    });
  }
  if (kind === 'network') {
    return errorState({
      title: 'The lead service is not responding',
      note: 'It may be restarting. Nothing is lost — the poller retries and this screen only reads.',
      retry,
    });
  }
  return errorState({
    title: 'Could not load this screen',
    note: err?.message || 'An unexpected problem occurred.',
    retry,
  });
}

export function banner(tone, ...content) {
  return h(`div.banner.banner-${tone}`,
    icon(tone === 'ok' ? 'check' : 'alert', 15, 'banner-icon'),
    h('div.grow', content));
}

/* ── Toasts ─────────────────────────────────────────────────────────────── */

let toastHost = null;

/** Transient confirmation, bottom-right. Auto-dismisses. */
export function toast(message, tone = '') {
  if (!toastHost) {
    toastHost = h('div.toast-host');
    document.body.append(toastHost);
  }
  const el = h(`div.toast${tone ? '.' + tone : ''}`,
    icon(tone === 'danger' ? 'alert' : 'check', 14), message);
  toastHost.append(el);
  setTimeout(() => {
    el.style.transition = 'opacity .2s ease';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 220);
  }, 3200);
}

/* ── Drawer ─────────────────────────────────────────────────────────────── */

/**
 * Right-hand drawer used for candidate/duplicate review. Closes on scrim
 * click and Escape so it never traps the user mid-demo.
 */
export function openDrawer({ title, subtitle, body, footer }) {
  const close = () => {
    scrim.remove();
    drawer.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };

  const scrim = h('div.scrim', { onclick: close });
  const drawer = h('aside.drawer', { role: 'dialog', 'aria-modal': 'true' },
    h('header.drawer-head',
      h('div',
        h('h2.panel-title', title),
        subtitle && h('div.t-xs.subtle', subtitle)),
      h('button.btn.btn-ghost.btn-sm', { onclick: close, 'aria-label': 'Close' }, icon('close', 14))),
    h('div.drawer-body', typeof body === 'function' ? body(close) : body),
    footer && h('footer.drawer-foot', typeof footer === 'function' ? footer(close) : footer),
  );

  document.body.append(scrim, drawer);
  document.addEventListener('keydown', onKey);
  return close;
}

/* ── Misc ───────────────────────────────────────────────────────────────── */

/** Percentage text coloured by confidence band — used in dense table cells. */
export function pctText(score) {
  if (score == null) return h('span.faint', '—');
  return h(`span.conf-value.conf-${confBand(score)}`, fmtPct(score));
}
