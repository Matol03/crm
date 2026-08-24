/**
 * Reusable data table: sorting, pagination and a row-click affordance.
 *
 * Filtering is deliberately left to the caller (each page knows its own filter
 * semantics); the table simply renders whatever rows it is given.
 */

import { h, icon, replace } from './dom.js';
import { emptyState, tableSkeleton } from './primitives.js';

/**
 * @param columns  [{ key, label, sortable, align, width, render(row), value(row) }]
 * @param rows     array of records
 * @param onRowClick optional (row) => void — makes rows keyboard-activatable too
 */
export function createTable({
  columns,
  rows = [],
  pageSize = 12,
  onRowClick,
  empty = { title: 'No results', note: 'Try adjusting your filters.' },
  initialSort = null,
}) {
  let data = rows;
  let sort = initialSort;   // { key, dir: 'asc' | 'desc' }
  let page = 1;
  let loading = false;

  const head = h('thead');
  const body = h('tbody');
  const foot = h('div.pagination');
  const wrap = h('div.table-wrap', h('table.data', head, body));
  const el = h('div', wrap, foot);

  const valueOf = (row, col) => (col.value ? col.value(row) : row[col.key]);

  function sorted() {
    if (!sort) return data;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return data;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...data].sort((a, b) => {
      const av = valueOf(a, col);
      const bv = valueOf(b, col);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;          // blanks always sort last
      if (bv == null) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv), undefined, { numeric: true }) * dir;
    });
  }

  function renderHead() {
    replace(head,
      h('tr', columns.map((col) => {
        const isSorted = sort?.key === col.key;
        return h('th' + (col.sortable ? '.sortable' : '') + (isSorted ? '.is-sorted' : ''), {
          style: col.width ? { width: col.width } : {},
          class: col.align === 'right' ? 'num' : null,
          onclick: col.sortable ? () => {
            sort = isSorted
              ? { key: col.key, dir: sort.dir === 'asc' ? 'desc' : 'asc' }
              : { key: col.key, dir: 'asc' };
            page = 1;
            render();
          } : null,
        },
          col.label,
          col.sortable && h('span.sort-arrow', isSorted ? (sort.dir === 'asc' ? '▲' : '▼') : '▲'),
        );
      })),
    );
  }

  function render() {
    renderHead();

    if (loading) {
      replace(body, h('tr', h('td', { colspan: columns.length }, tableSkeleton(6))));
      replace(foot);
      return;
    }
    if (!data.length) {
      replace(body, h('tr', h('td', { colspan: columns.length }, emptyState(empty))));
      replace(foot);
      return;
    }

    const all = sorted();
    const pages = Math.max(1, Math.ceil(all.length / pageSize));
    page = Math.min(page, pages);
    const slice = all.slice((page - 1) * pageSize, page * pageSize);

    replace(body, slice.map((row) =>
      h('tr' + (onRowClick ? '.clickable' : ''), {
        tabindex: onRowClick ? 0 : null,
        onclick: onRowClick ? () => onRowClick(row) : null,
        onkeydown: onRowClick ? (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRowClick(row); }
        } : null,
      }, columns.map((col) =>
        h('td', { class: col.align === 'right' ? 'num' : null }, col.render ? col.render(row) : valueOf(row, col) ?? h('span.faint', '—')))),
    ));

    const from = (page - 1) * pageSize + 1;
    const to = Math.min(all.length, page * pageSize);
    replace(foot,
      h('div', `${from}–${to} of ${all.length}`),
      pages > 1 && h('div.row',
        h('button.btn.btn-sm', { disabled: page === 1, onclick: () => { page--; render(); } },
          icon('arrowLeft', 13), 'Previous'),
        h('span.t-sm', { style: { padding: '0 var(--sp-2)' } }, `${page} / ${pages}`),
        h('button.btn.btn-sm', { disabled: page === pages, onclick: () => { page++; render(); } },
          'Next', icon('chevronRight', 13))),
    );
  }

  render();

  return {
    el,
    setRows(next) { data = next; page = 1; loading = false; render(); },
    setLoading(v) { loading = v; render(); },
    get count() { return data.length; },
  };
}
