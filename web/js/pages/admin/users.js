/**
 * Users / Teams mapping (admin only).
 *
 * The mapping that matters operationally: a Teams author must resolve to a
 * Bitrix user, otherwise the lead falls back to the default owner and is
 * flagged. Unmapped managers are called out rather than hidden.
 */

import { h, replace, fmtNum } from '../../ui/dom.js';
import { panel, badge, banner, toast } from '../../ui/primitives.js';
import { createTable } from '../../ui/table.js';
import { getUsers } from '../../api.js';

export async function renderUsers(root) {
  const { data: users } = await getUsers();
  const unmapped = users.filter((u) => !u.mapped);

  const table = createTable({
    columns: [
      {
        key: 'name', label: 'Manager', sortable: true,
        render: (u) => h('div',
          h('div.cell-primary', u.name),
          h('div.cell-secondary.truncate', u.email)),
      },
      {
        key: 'role', label: 'Role', sortable: true,
        render: (u) => badge(u.role, u.role === 'Administrator' ? 'purple' : 'neutral'),
      },
      {
        key: 'bitrixUserId', label: 'Bitrix user', sortable: true,
        render: (u) => u.mapped
          ? h('span.mono.t-xs', `#${u.bitrixUserId}`)
          : h('span.t-xs', { style: { color: 'var(--c-warn)' } }, 'Not mapped'),
      },
      { key: 'leads', label: 'Leads', sortable: true, align: 'right', render: (u) => fmtNum(u.leads) },
      {
        key: 'mapped', label: '', align: 'right',
        render: (u) => h('button.btn.btn-sm', {
          onclick: () => toast(u.mapped ? `Mapping for ${u.name} opened` : `Map ${u.name} to a Bitrix user`),
        }, u.mapped ? 'Edit' : 'Map'),
      },
    ],
    rows: users,
    pageSize: 10,
    initialSort: { key: 'leads', dir: 'desc' },
  });

  replace(root,
    h('div.page-head',
      h('div',
        h('h1.page-title', 'Users / Teams mapping'),
        h('p.page-subtitle', 'Whoever posts the message owns the lead — that requires a Bitrix user')),
      h('div.row',
        h('button.btn', { onclick: () => toast('Directory sync started') }, 'Sync from Teams'))),

    unmapped.length
      ? h('div', { style: { marginBottom: 'var(--sp-4)' } },
          banner('warn',
            h('div',
              h('div.fw-medium', `${unmapped.length} manager${unmapped.length === 1 ? '' : 's'} not mapped to a Bitrix user`),
              h('div.t-xs', { style: { marginTop: '2px' } },
                'Their leads are assigned to the default owner and flagged for manual correction: '
                + unmapped.map((u) => u.name).join(', ')))))
      : null,

    panel({ flush: true, body: table.el }),
  );
}
