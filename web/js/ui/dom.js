/**
 * Minimal DOM helpers.
 *
 * The whole UI is built by composing `h()` calls rather than assembling HTML
 * strings — this keeps everything escaped by construction (text is always set
 * via textContent), so no lead content can inject markup.
 */

/**
 * Create an element.
 *
 *   h('div.panel', { onclick: fn }, h('span', 'hello'))
 *
 * The tag accepts a CSS-ish shorthand: `tag.class1.class2`.
 * Props: `class`/`className`, `style` (object), `dataset` (object),
 * `on*` handlers, `html` (trusted markup only — used for inline SVG icons),
 * anything else becomes an attribute.
 * Children may be nodes, strings/numbers, arrays, or null/false (skipped).
 */
export function h(tag, props, ...children) {
  // Tag syntax: 'input.cls#id' or 'div#id.cls'. The '#id' part must be split
  // off before the '.' split, or it silently becomes part of a class name and
  // the element ends up with no id at all — which quietly breaks any
  // <label for="..."> pointing at it.
  const raw = String(tag);
  let id = '';
  let rest = raw;
  const hashAt = raw.indexOf('#');
  if (hashAt !== -1) {
    const after = raw.slice(hashAt + 1);
    const dot = after.indexOf('.');
    id = dot === -1 ? after : after.slice(0, dot);
    rest = raw.slice(0, hashAt) + (dot === -1 ? '' : after.slice(dot));
  }
  const [name, ...classes] = rest.split('.');
  const el = document.createElement(name || 'div');
  if (id) el.id = id;
  if (classes.length) el.className = classes.join(' ');

  // Allow h('div', 'text') and h('div', [nodes]) without a props object.
  if (props != null && (typeof props !== 'object' || Array.isArray(props) || props instanceof Node)) {
    children.unshift(props);
    props = null;
  }

  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class' || key === 'className') {
      el.className = [el.className, value].filter(Boolean).join(' ');
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign(el.style, value);
    } else if (key === 'dataset') {
      Object.assign(el.dataset, value);
    } else if (key === 'html') {
      el.innerHTML = value;
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) {
      el.setAttribute(key, '');
    } else {
      el.setAttribute(key, value);
    }
  }

  append(el, children);
  return el;
}

/** Append children of any supported shape. */
export function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false || child === '') continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

/** Replace an element's entire content. */
export function replace(parent, ...children) {
  parent.replaceChildren();
  return append(parent, children);
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ── Icons ────────────────────────────────────────────────────────────────
   A small inline set. Inline SVG keeps the app self-contained (no icon font,
   no external requests) and lets icons inherit `currentColor`.
   ---------------------------------------------------------------------- */

const PATHS = {
  dashboard: '<rect x="2.5" y="2.5" width="5.5" height="5.5" rx="1"/><rect x="10" y="2.5" width="5.5" height="5.5" rx="1"/><rect x="2.5" y="10" width="5.5" height="5.5" rx="1"/><rect x="10" y="10" width="5.5" height="5.5" rx="1"/>',
  leads: '<path d="M3 4.5h12M3 9h12M3 13.5h8"/>',
  unresolved: '<path d="M9 2.6 16 14.5H2L9 2.6Z"/><path d="M9 7.2v3.1M9 12.4v.05"/>',
  duplicates: '<rect x="6" y="6" width="9" height="9" rx="1.5"/><path d="M12 6V4.5A1.5 1.5 0 0 0 10.5 3H4.5A1.5 1.5 0 0 0 3 4.5v6A1.5 1.5 0 0 0 4.5 12H6"/>',
  analytics: '<path d="M3 15V8M7.5 15V3.5M12 15v-4.5M16 15V6"/>',
  campaign: '<path d="M3 7.5v3a1 1 0 0 0 1 1h2l4.5 3V3.5L6 6.5H4a1 1 0 0 0-1 1Z"/><path d="M13.5 6.2a4 4 0 0 1 0 5.6"/>',
  channels: '<path d="M6.5 2.5 5 15.5M12 2.5 10.5 15.5M2.5 6h13M2 12h13"/>',
  users: '<circle cx="7" cy="6" r="2.6"/><path d="M2.5 15c0-2.5 2-4.2 4.5-4.2S11.5 12.5 11.5 15"/><path d="M12.2 4.2a2.4 2.4 0 0 1 0 4.4M13.4 10.9c1.4.5 2.4 1.9 2.4 4.1"/>',
  integrations: '<path d="M7 2.5v4M11 2.5v4"/><rect x="4" y="6.5" width="10" height="4.5" rx="1.5"/><path d="M9 11v2.2a2.3 2.3 0 0 1-2.3 2.3H6"/>',
  diagnostics: '<path d="M2.5 9h3l2-4.5 3 9L12.5 9h3"/>',
  search: '<circle cx="7.5" cy="7.5" r="4.5"/><path d="M11 11l4 4"/>',
  close: '<path d="M4.5 4.5l9 9M13.5 4.5l-9 9"/>',
  check: '<path d="M3.5 9.5 7 13l7.5-7.5"/>',
  chevronRight: '<path d="M6.5 3.5 12 9l-5.5 5.5"/>',
  chevronDown: '<path d="M3.5 6.5 9 12l5.5-5.5"/>',
  arrowLeft: '<path d="M14.5 9h-11M8 4 3.2 9 8 14"/>',
  mic: '<rect x="6.7" y="2" width="4.6" height="8" rx="2.3"/><path d="M3.8 8.4a5.2 5.2 0 0 0 10.4 0M9 13.6V16"/>',
  camera: '<path d="M2.5 6.2h2.6l1.2-1.8h4.4l1.2 1.8h2.6v8H2.5z"/><circle cx="9" cy="10" r="2.4"/>',
  message: '<path d="M15 10.5a2 2 0 0 1-2 2H6l-3.5 3v-11a2 2 0 0 1 2-2h8.5a2 2 0 0 1 2 2Z"/>',
  refresh: '<path d="M15 8a6 6 0 1 0-1.6 4.6"/><path d="M15.2 3.5V8h-4.4"/>',
  clock: '<circle cx="9" cy="9" r="6.5"/><path d="M9 5.2V9l2.6 1.6"/>',
  external: '<path d="M10.5 3.5H14v3.5M14 3.5 8.5 9"/><path d="M13 10.8V13a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 13V6.5A1.5 1.5 0 0 1 5 5h2.4"/>',
  alert: '<circle cx="9" cy="9" r="6.5"/><path d="M9 5.4v4.2M9 12.2v.05"/>',
  inbox: '<path d="M2.5 9.5h3.2l1 2.2h4.6l1-2.2h3.2"/><path d="M4.2 3.5h9.6l2 6v4a1.5 1.5 0 0 1-1.5 1.5H3.7a1.5 1.5 0 0 1-1.5-1.5v-4Z"/>',
  merge: '<path d="M5.5 15V9.5a3 3 0 0 1 3-3h4"/><path d="M10 3.8 12.9 6.5 10 9.2"/><path d="M5.5 3v2"/>',
  split: '<path d="M4 3v3.5a3 3 0 0 0 3 3h7"/><path d="M11.5 6.8 14.4 9.5l-2.9 2.7"/>',
  play: '<path d="M6 4.2 13 9l-7 4.8Z"/>',
};

/** Build an inline SVG icon that inherits colour and sizes to `size`. */
export function icon(name, size = 16, extraClass = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 18 18');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (extraClass) svg.setAttribute('class', extraClass);
  svg.innerHTML = PATHS[name] || '';
  return svg;
}

/* ── Formatters ───────────────────────────────────────────────────────── */

/** `2026-08-23T13:20:00Z` → `13:20` (local time). */
export function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** `2026-08-23T13:20:00Z` → `23 Aug, 13:20`. */
export function fmtDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${fmtTime(iso)}`;
}

/** Coarse relative age, e.g. `4m ago`. Good enough for an ops feed. */
export function fmtAgo(iso) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

export const fmtPct = (n) => (n == null ? '—' : `${Math.round(n * 100)}%`);

/** One-decimal percentage — for quality metrics where 98.4% ≠ 98%. */
export const fmtPct1 = (n) => (n == null ? '—' : `${(n * 100).toFixed(1)}%`);

/** Thousands separator, tabular-friendly. */
export const fmtNum = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));

/** Title-case a slug: `needs_review` → `Needs review`. */
export function humanize(s) {
  if (!s) return '';
  const t = String(s).replace(/[_-]+/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}
