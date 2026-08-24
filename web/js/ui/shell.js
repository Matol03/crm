/**
 * Application shell: brand, top bar (campaign, connection, role) and the
 * sidebar. Rendered once; only the `.main` region is swapped per route.
 */

import { h, icon, replace } from './dom.js';
import { state, isAdmin, setRole, ADMIN_ROUTES } from '../state.js';
import { current, navigate } from '../router.js';
import { connection, getSecret, setSecret } from '../api.js';
import { openDrawer, toast } from './primitives.js';

const MAIN_NAV = [
  { route: 'dashboard',  label: 'Dashboard',  icon: 'dashboard' },
  { route: 'leads',      label: 'Leads',      icon: 'leads', children: [
      { route: 'leads', query: '', label: 'All' },
      { route: 'leads', query: 'status=needs_review', label: 'Needs review' },
      { route: 'leads', query: 'status=failed', label: 'Failed' },
      { route: 'leads', query: 'status=created', label: 'Synced' },
    ] },
  { route: 'unresolved', label: 'Unresolved', icon: 'unresolved', badge: 3 },
  { route: 'duplicates', label: 'Duplicates', icon: 'duplicates', badge: 2 },
  { route: 'analytics',  label: 'Analytics',  icon: 'analytics' },
];

const ADMIN_NAV = [
  { route: 'campaign',     label: 'Campaign',      icon: 'campaign' },
  { route: 'channels',     label: 'Teams Channels', icon: 'channels' },
  { route: 'users',        label: 'Users / Mapping', icon: 'users' },
  { route: 'integrations', label: 'Integrations',  icon: 'integrations' },
  { route: 'diagnostics',  label: 'Diagnostics',   icon: 'diagnostics' },
];

let sidebarEl = null;
let statusEl = null;

function navItem({ route, query = '', label, icon: iconName, badge }, activeRoute, activeQuery) {
  const href = `#/${route}${query ? `?${query}` : ''}`;
  const isActive = activeRoute === route && (query ? activeQuery === query : !activeQuery);
  return h('a.nav-item' + (isActive ? '.is-active' : ''), {
    href,
    'aria-current': isActive ? 'page' : null,
  },
    iconName && icon(iconName, 16, 'nav-icon'),
    h('span.grow.truncate', label),
    badge != null && h('span.nav-count', badge),
  );
}

/** Rebuild the sidebar (called on route change and on role change). */
export function renderSidebar() {
  if (!sidebarEl) return;
  const route = current();
  const activeQuery = new URLSearchParams(route.query).toString();

  const groups = [
    h('div.nav-group', MAIN_NAV.map((item) => {
      const rows = [navItem(item, route.name, item.children ? activeQuery : activeQuery)];
      // Sub-navigation for Leads, only while that section is open.
      if (item.children && route.name === item.route) {
        rows.push(h('div.nav-sub', item.children.map((c) => navItem(c, route.name, activeQuery))));
      }
      return rows;
    })),
  ];

  if (isAdmin()) {
    groups.push(h('div.nav-divider'));
    groups.push(h('div.nav-group',
      h('div.nav-group-label', 'Admin'),
      ADMIN_NAV.map((item) => navItem(item, route.name, activeQuery)),
    ));
  }

  replace(sidebarEl, groups);
}

/** Connection pill — reflects whether live API data is flowing. */
export function renderConnection() {
  if (!statusEl) return;
  const live = connection.live;
  replace(statusEl,
    h(`span.badge.badge-${live ? 'ok' : 'neutral'}`,
      h('span.dot' + (live ? '.live' : '')),
      live ? 'Live processing' : 'Demo data'),
  );
  statusEl.title = live
    ? 'Connected to the lead-service API'
    : `Showing fixtures — ${connection.reason || 'no API secret set'}`;
}

/** Prompt for the API secret so the UI can switch to live data. */
function openConnectionDrawer() {
  let input;
  openDrawer({
    title: 'Data source',
    subtitle: 'Connect this interface to the running lead-service',
    body: h('div.stack-4',
      h('p.t-sm.muted',
        'Without a secret the interface shows realistic demo fixtures so it can be explored offline. ',
        'Enter the API shared secret to read leads from the live service instead.'),
      h('div',
        h('label.field-label', { for: 'api-secret' }, 'API shared secret'),
        (input = h('input.input#api-secret', {
          type: 'password', value: getSecret(), placeholder: 'API_SHARED_SECRET',
          autocomplete: 'off', spellcheck: 'false',
        }))),
      h('div.banner.banner-info',
        h('div', h('div.fw-medium', 'What changes when connected'),
          h('div.t-xs', { style: { marginTop: '2px' } },
            'Leads, statuses, source messages, verbatim text and AI summaries come from the service. ',
            'Per-field confidence and provenance are not recorded by the backend yet, so those appear as “not recorded”.'))),
    ),
    footer: (close) => [
      h('button.btn.btn-primary', {
        onclick: async () => {
          setSecret(input.value.trim());
          close();
          toast(input.value.trim() ? 'Reconnecting…' : 'Switched to demo data');
          const { checkConnection } = await import('../api.js');
          await checkConnection();
          renderConnection();
          const { resolve } = await import('../router.js');
          resolve();
        },
      }, 'Save'),
      h('button.btn', { onclick: (e) => { setSecret(''); e.target.closest('.drawer') && null; close(); toast('Switched to demo data'); renderConnection(); } }, 'Use demo data'),
    ],
  });
}

/** Build the persistent shell and return the main content element. */
export function mountShell(root) {
  sidebarEl = h('nav.sidebar', { 'aria-label': 'Main' });
  statusEl = h('button.btn.btn-ghost.btn-sm', { onclick: openConnectionDrawer, title: 'Data source' });

  const roleSwitch = h('div.segmented', { role: 'group', 'aria-label': 'Role' },
    ...['admin', 'user'].map((r) =>
      h('button' + (state.role === r ? '.is-active' : ''), {
        onclick: () => {
          setRole(r);
          // Leaving admin while on an admin page must not strand the user.
          if (r === 'user' && ADMIN_ROUTES.has(current().name)) navigate('dashboard');
          else { renderSidebar(); }
          renderRoleSwitch();
        },
      }, r === 'admin' ? 'Admin' : 'User')),
  );

  function renderRoleSwitch() {
    [...roleSwitch.children].forEach((btn, i) => {
      btn.classList.toggle('is-active', state.role === ['admin', 'user'][i]);
    });
  }

  const main = h('main.main', h('div.main-inner'));

  root.append(
    h('div.app',
      h('div.brand-cell',
        h('div.brand-mark', 'LS'),
        h('div.brand-name', 'LeadStream')),
      h('header.topbar',
        h('div.row-4',
          h('div.row', { style: { gap: '6px' } },
            icon('campaign', 15, 'subtle'),
            h('span.fw-medium', state.campaign)),
          statusEl),
        h('div.row-4',
          roleSwitch,
          h('div.row', { style: { gap: '8px' } },
            h('div.brand-mark', { style: { background: 'var(--c-surface-sunken)', color: 'var(--c-text-muted)' } }, 'MA'),
            h('div.t-sm.fw-medium', 'Murat A.')))),
      sidebarEl,
      main),
  );

  renderSidebar();
  renderConnection();
  return main.firstElementChild;
}
