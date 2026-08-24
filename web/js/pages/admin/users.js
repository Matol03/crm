/**
 * Users / mapping (admin).
 *
 * Two sources, deliberately shown side by side: the real Bitrix24 users, and
 * the Teams-email → Bitrix-user mapping this service holds. A manager missing
 * from the mapping is the reason their leads fall to the default owner, so the
 * gap is called out rather than buried.
 */

import { h, replace } from '../../ui/dom.js';
import { panel, badge, banner, apiErrorState } from '../../ui/primitives.js';
import { createTable } from '../../ui/table.js';
import { getReference, getSystem } from '../../api.js';

export async function renderUsers(root) {
  let ref, sys;
  try {
    [ref, sys] = await Promise.all([getReference(), getSystem()]);
  } catch (err) {
    replace(root, apiErrorState(err, () => renderUsers(root)));
    return;
  }

  const mapping = sys.employeeMap || [];
  const mappedIds = new Set(mapping.map((m) => String(m.bitrix_user_id)));
  const defaultOwnerId = sys.tuning?.defaultOwnerId;

  const users = Object.entries(ref.users || {}).map(([id, name]) => ({
    id: Number(id),
    name,
    mapped: mappedIds.has(id),
    teamsEmail: mapping.find((m) => String(m.bitrix_user_id) === id)?.teams_email ?? null,
    isDefault: String(defaultOwnerId) === id,
  }));

  const table = createTable({
    columns: [
      {
        key: 'name', label: 'Bitrix user', sortable: true,
        render: (u) => h('div',
          h('div.cell-primary', u.name),
          h('div.cell-secondary.mono', `#${u.id}`)),
      },
      {
        key: 'teamsEmail', label: 'Teams identity', sortable: true,
        render: (u) => u.teamsEmail
          ? h('span.truncate', u.teamsEmail)
          : h('span.t-xs', { style: { color: 'var(--c-warn)' } }, 'Not mapped'),
      },
      {
        key: 'mapped', label: 'Owns leads as', sortable: true,
        render: (u) => u.mapped
          ? badge('Themselves', 'ok')
          : u.isDefault ? badge('Default owner', 'info') : badge('—', 'neutral'),
      },
    ],
    rows: users,
    pageSize: 12,
    initialSort: { key: 'name', dir: 'asc' },
  });

  const unmappedCount = users.filter((u) => !u.mapped).length;

  replace(root,
    h('div.page-head',
      h('div',
        h('h1.page-title', 'Users / mapping'),
        h('p.page-subtitle', 'Whoever posts the message owns the lead — which needs a Teams → Bitrix mapping'))),

    mapping.length === 0
      ? h('div', { style: { marginBottom: 'var(--sp-4)' } },
          banner('warn',
            h('div',
              h('div.fw-medium', 'No Teams identities are mapped'),
              h('div.t-xs', { style: { marginTop: '2px' } },
                `Every lead is therefore assigned to the default owner`
                + (defaultOwnerId != null ? ` (${ref.users?.[String(defaultOwnerId)] || '#' + defaultOwnerId})` : '')
                + ' and flagged for manual correction.'))))
      : unmappedCount
        ? h('div', { style: { marginBottom: 'var(--sp-4)' } },
            banner('info', h('div', `${unmappedCount} Bitrix user${unmappedCount === 1 ? '' : 's'} have no Teams identity mapped.`)))
        : null,

    panel({ flush: true, body: table.el }),
  );
}
