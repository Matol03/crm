/**
 * Leads — the primary working table.
 *
 * Filtering happens here (the table component only renders); the active filter
 * set is reflected as removable chips so it is always obvious why a row count
 * looks the way it does.
 */

import { h, icon, replace, fmtDateTime, humanize } from '../ui/dom.js';
import { panel, statusBadge, badge, confidence, apiErrorState } from '../ui/primitives.js';
import { createTable } from '../ui/table.js';
import { getLeads } from '../api.js';
import { navigate } from '../router.js';

const PRIORITY_TONE = { High: 'danger', Medium: 'warn', Low: 'neutral' };

const CONFIDENCE_BANDS = {
  high: { label: '90%+', test: (c) => c >= 0.9 },
  good: { label: '75–89%', test: (c) => c >= 0.75 && c < 0.9 },
  mid:  { label: '60–74%', test: (c) => c >= 0.6 && c < 0.75 },
  low:  { label: 'Below 60%', test: (c) => c < 0.6 },
};

export async function renderLeads(root, route) {
  const filters = {
    q: '',
    status: route.query.status || '',
    priority: '',
    owner: '',
    leadType: '',
    confidence: '',
    since: '',
  };

  let all;
  try {
    all = await getLeads();
  } catch (err) {
    replace(root, apiErrorState(err, () => renderLeads(root, route)));
    return;
  }

  const owners = [...new Set(all.map((l) => l.owner?.name).filter(Boolean))].sort();

  function matches(lead) {
    const { q, status, priority, owner, leadType, confidence: band, since } = filters;
    if (q) {
      const hay = [lead.person?.name, lead.company, lead.person?.position,
        ...(lead.emails || []).map((e) => e.value)].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q.toLowerCase())) return false;
    }
    if (status && lead.status !== status) return false;
    if (priority && lead.priority !== priority) return false;
    if (owner && lead.owner?.name !== owner) return false;
    if (leadType && lead.leadType !== leadType) return false;
    if (band) {
      const c = lead.confidence?.overall;
      if (c == null || !CONFIDENCE_BANDS[band].test(c)) return false;
    }
    if (since) {
      const cutoff = Date.now() - Number(since) * 3600_000;
      if (new Date(lead.createdAt).getTime() < cutoff) return false;
    }
    return true;
  }

  const table = createTable({
    columns: [
      {
        key: 'person', label: 'Lead', sortable: true, width: '22%',
        value: (l) => l.person?.name,
        render: (l) => h('div',
          h('div.cell-primary.truncate', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
            h('span.truncate', l.person?.name || 'Unnamed'),
            l.sameName?.count > 0 && badge(
              l.sameName.kind === 'partial' ? 'Possible duplicate'
                : l.sameName.count === 1 ? 'Duplicate' : `${l.sameName.count} duplicates`,
              'warn',
              { title: l.sameName.kind === 'partial'
                  ? `This name is contained in lead #${l.sameName.ids.join(', #')} — it may be the same person captured twice`
                  : `Same name as lead #${l.sameName.ids.join(', #')}` })),
          l.person?.position && h('div.cell-secondary.truncate', l.person.position)),
      },
      {
        key: 'company', label: 'Company', sortable: true,
        render: (l) => l.company
          ? h('div', h('div.truncate', l.company), l.country && h('div.cell-secondary', l.country))
          : h('span.faint', 'Not detected'),
      },
      {
        key: 'owner', label: 'Owner', sortable: true,
        value: (l) => l.owner?.name,
        render: (l) => l.owner?.name ? h('span.truncate', l.owner.name) : h('span.faint', '—'),
      },
      {
        key: 'leadType', label: 'Type', sortable: true,
        render: (l) => l.leadType
          ? badge(humanize(l.leadType), l.leadType === 'partner' ? 'purple' : 'neutral')
          : h('span.faint', '—'),
      },
      {
        key: 'productInterest', label: 'Interest', sortable: true,
        render: (l) => l.productInterest ? h('span.truncate', l.productInterest) : h('span.faint', '—'),
      },
      {
        key: 'priority', label: 'Priority', sortable: true,
        render: (l) => l.priority ? badge(l.priority, PRIORITY_TONE[l.priority] || 'neutral') : h('span.faint', '—'),
      },
      {
        key: 'confidence', label: 'Confidence', sortable: true, width: '120px',
        value: (l) => l.confidence?.overall,
        render: (l) => l.confidence?.overall == null
          ? h('span.faint.t-xs', 'not recorded')
          : confidence(l.confidence.overall),
      },
      {
        key: 'statusLabel', label: 'Status', sortable: true,
        // The label is whatever the portal calls it; the tone comes from the key.
        render: (l) => statusBadge(l.status, { label: l.statusLabel }),
      },
      {
        key: 'createdAt', label: 'Created', sortable: true,
        value: (l) => new Date(l.createdAt).getTime(),
        render: (l) => h('span.t-xs.subtle', fmtDateTime(l.createdAt)),
      },
      {
        key: 'bitrixLeadId', label: 'Bitrix', sortable: true, align: 'right',
        render: (l) => l.bitrixLeadId
          ? h('span.mono.t-xs', `#${l.bitrixLeadId}`)
          : h('span.faint', '—'),
      },
    ],
    rows: all.filter(matches),
    initialSort: { key: 'createdAt', dir: 'desc' },
    onRowClick: (lead) => navigate(`leads/${lead.id}`),
    empty: {
      title: 'No leads match these filters',
      note: 'Clear a filter or widen the date range to see more.',
    },
  });

  /* ── Filter bar ─────────────────────────────────────────────────────── */

  const chipRow = h('div.row.wrap', { style: { gap: 'var(--sp-2)' } });

  function apply() {
    table.setRows(all.filter(matches));
    renderChips();
    countLabel.textContent = `${table.count} of ${all.length}`;
  }

  function renderChips() {
    const active = Object.entries(filters).filter(([, v]) => v);
    replace(chipRow, active.length
      ? [
        ...active.map(([key, value]) => h('span.filter-chip',
          `${chipLabel(key)}: ${chipValue(key, value)}`,
          h('button', { onclick: () => { filters[key] = value === filters[key] ? '' : filters[key]; filters[key] = ''; syncControls(); apply(); }, 'aria-label': `Remove ${key} filter` }, '×'))),
        h('button.btn.btn-ghost.btn-sm', {
          onclick: () => { Object.keys(filters).forEach((k) => (filters[k] = '')); syncControls(); apply(); },
        }, 'Clear all'),
      ]
      : []);
  }

  const chipLabel = (k) => ({ q: 'Search', status: 'Status', priority: 'Priority', owner: 'Owner', leadType: 'Type', confidence: 'Confidence', since: 'Created' })[k] || k;
  const chipValue = (k, v) => {
    if (k === 'confidence') return CONFIDENCE_BANDS[v]?.label || v;
    if (k === 'since') return v === '24' ? 'last 24h' : v === '168' ? 'last 7 days' : `last ${v}h`;
    return humanize(v);
  };

  const searchInput = h('input.input', {
    type: 'search', placeholder: 'Search name, company, email…', value: filters.q,
    oninput: (e) => { filters.q = e.target.value; apply(); },
  });

  const selects = {
    status: h('select.select', {
      onchange: (e) => { filters.status = e.target.value; apply(); },
    }, ...[['', 'All statuses'], ['new', 'Unprocessed'], ['processing', 'In progress'],
        ['created', 'Completed'], ['failed', 'Rejected']]
      .map(([v, l]) => h('option', { value: v, selected: filters.status === v || null }, l))),
    priority: h('select.select', {
      onchange: (e) => { filters.priority = e.target.value; apply(); },
    }, ...[['', 'Any priority'], ['High', 'High'], ['Medium', 'Medium'], ['Low', 'Low']]
      .map(([v, l]) => h('option', { value: v }, l))),
    leadType: h('select.select', {
      onchange: (e) => { filters.leadType = e.target.value; apply(); },
    }, ...[['', 'Any type'], ['Customer', 'Customer'], ['Partner', 'Partner']]
      .map(([v, l]) => h('option', { value: v }, l))),
    owner: h('select.select', {
      onchange: (e) => { filters.owner = e.target.value; apply(); },
    }, ...[['', 'Any owner'], ...owners.map((o) => [o, o])].map(([v, l]) => h('option', { value: v }, l))),
    confidence: h('select.select', {
      onchange: (e) => { filters.confidence = e.target.value; apply(); },
    }, ...[['', 'Any confidence'], ...Object.entries(CONFIDENCE_BANDS).map(([k, b]) => [k, b.label])]
      .map(([v, l]) => h('option', { value: v }, l))),
    since: h('select.select', {
      onchange: (e) => { filters.since = e.target.value; apply(); },
    }, ...[['', 'Any time'], ['24', 'Last 24 hours'], ['168', 'Last 7 days']]
      .map(([v, l]) => h('option', { value: v }, l))),
  };

  function syncControls() {
    searchInput.value = filters.q;
    for (const [key, el] of Object.entries(selects)) el.value = filters[key];
  }

  const countLabel = h('span.t-sm.subtle', `${table.count} of ${all.length}`);

  syncControls();
  renderChips();

  replace(root,
    h('div.page-head',
      h('div',
        h('h1.page-title', 'Leads'),
        h('p.page-subtitle', 'Click a lead to see its evidence')),
      h('div.row', countLabel)),

    panel({
      flush: true,
      body: h('div',
        h('div.filters',
          h('div.search', h('span.search-icon', icon('search', 14)), searchInput),
          selects.status, selects.priority, selects.leadType,
          selects.owner, selects.confidence, selects.since),
        chipRow.children.length ? h('div.filters', { style: { paddingTop: 'var(--sp-2)', paddingBottom: 'var(--sp-2)' } }, chipRow) : chipRow,
        table.el),
    }),
  );
}
