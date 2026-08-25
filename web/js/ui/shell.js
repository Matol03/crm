/**
 * Application shell: brand, top bar (campaign, connection, role) and the
 * sidebar. Rendered once; only the `.main` region is swapped per route.
 */

import { h, icon, replace } from './dom.js';
import { state, isAdmin, setRole, ADMIN_ROUTES } from '../state.js';
import { current, navigate } from '../router.js';
import { connection, dataSource, getSecret, setSecret } from '../api.js';
import { openDrawer, toast } from './primitives.js';

const MAIN_NAV = [
  { route: 'dashboard',  label: 'Dashboard',  icon: 'dashboard' },
  { route: 'leads',      label: 'Leads',      icon: 'leads', children: [
      { route: 'leads', query: '', label: 'All' },
      { route: 'leads', query: 'status=new', label: 'Unprocessed' },
      { route: 'leads', query: 'status=processing', label: 'In progress' },
      { route: 'leads', query: 'status=created', label: 'Qualified' },
    ] },
  { route: 'unresolved', label: 'Needs attention', icon: 'unresolved' },
  { route: 'duplicates', label: 'Duplicates', icon: 'duplicates' },
  { route: 'analytics',  label: 'Analytics',  icon: 'analytics' },
  { route: 'logs',       label: 'Activity log', icon: 'clock' },
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
  const sampling = dataSource.mode === 'sample';
  const live = connection.live && !sampling;
  replace(statusEl,
    h(`span.badge.badge-${live ? 'ok' : sampling ? 'warn' : 'neutral'}`,
      h('span.dot' + (live ? '.live' : '')),
      live ? 'Live data' : sampling ? 'Sample data' : 'Not connected'),
  );
  statusEl.title = live
    ? 'Reading live data from Bitrix24 through the lead service'
    : sampling
      ? `Showing fallback sample data — ${dataSource.reason}`
      : `Not reading data — ${connection.reason || 'no API secret set'}`;
  renderSampleBanner();
}

/**
 * A persistent strip above the content whenever the screen is showing fallback
 * data. The pill alone is too easy to miss, and sample figures must never be
 * mistaken for the real pipeline.
 */
function renderSampleBanner() {
  const host = document.querySelector('.main-inner');
  if (!host) return;
  const existing = host.previousElementSibling?.classList?.contains('sample-strip')
    ? host.previousElementSibling : null;
  if (dataSource.mode !== 'sample') { existing?.remove(); return; }
  if (existing) return;
  const strip = h('div.banner.banner-warn.sample-strip', { style: { margin: '0 0 var(--sp-5)' } },
    icon('alert', 15),
    h('div.grow',
      h('div.fw-medium', 'Showing sample data'),
      h('div.t-xs', { style: { marginTop: '2px' } },
        `${dataSource.reason} Nothing on this screen reflects your real leads.`)));
  host.parentElement?.insertBefore(strip, host);
}

/** Prompt for the API secret so the UI can switch to live data. */
function openConnectionDrawer() {
  let input;
  let errorSlot;
  const showError = (msg) => {
    if (!errorSlot) return;
    errorSlot.textContent = '';
    errorSlot.appendChild(
      h('div.banner.banner-warn', h('div', h('div.fw-medium', 'Not connected'),
        h('div.t-xs', { style: { marginTop: '2px' } }, msg))));
  };
  openDrawer({
    title: 'Connect to the lead service',
    subtitle: 'The console reads leads through the service',
    body: h('div.stack-4',
      h('p.t-sm.muted',
        'This console has no data of its own. It reads leads and the AI metadata from the ',
        'service’s database, so it needs the service’s API secret.'),
      (errorSlot = h('div')),
      h('div',
        h('label.field-label', { for: 'api-secret' }, 'API shared secret'),
        (input = h('input.input#api-secret', {
          type: 'password', value: getSecret(), placeholder: 'API_SHARED_SECRET',
          autocomplete: 'off', spellcheck: 'false',
        }))),
      h('div.banner.banner-info',
        h('div', h('div.fw-medium', 'Where to find the secret'),
          h('div.t-xs', { style: { marginTop: '2px' } },
            'It is the API_SHARED_SECRET value in the service’s .env file. Copy the value only — ',
            'not the name, the equals sign, or any quotes. It is kept for this browser tab only ',
            'and is never put in the address bar.'))),
    ),
    footer: (close) => [
      h('button.btn.btn-primary', {
        onclick: async (ev) => {
          const value = input.value.trim();
          if (!value) { showError('Enter the API shared secret first.'); input.focus(); return; }

          // Verify BEFORE closing. Closing on a bad secret just drops the user
          // back to sample data with no idea why it did not connect.
          const btn = ev.currentTarget;
          btn.disabled = true;
          const previous = btn.textContent;
          btn.textContent = 'Checking…';
          setSecret(value);
          const { checkConnection } = await import('../api.js');
          const ok = await checkConnection();
          btn.disabled = false;
          btn.textContent = previous;

          if (!ok) {
            setSecret('');
            renderConnection();
            showError(
              connection.reason === 'Invalid API secret'
                ? 'That secret was rejected. Copy the API_SHARED_SECRET value from the service’s .env — the value only, without the name or quotes.'
                : `Could not connect: ${connection.reason || 'the service is not responding'}.`,
            );
            return;
          }
          close();
          toast('Connected');
          renderConnection();
          const { resolve } = await import('../router.js');
          resolve();
        },
      }, 'Save'),
      h('button.btn', {
        onclick: () => { setSecret(''); close(); toast('Disconnected'); renderConnection(); },
      }, 'Disconnect'),
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
