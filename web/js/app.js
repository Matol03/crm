/**
 * Application entry point: mounts the shell, wires routes, starts the router.
 *
 * Pages are loaded lazily so the initial screen paints without parsing every
 * module — the app has no bundler, so this doubles as code-splitting.
 */

import { h, replace } from './ui/dom.js';
import { errorState } from './ui/primitives.js';
import { mountShell, renderSidebar, renderConnection, renderCampaign } from './ui/shell.js';
import { register, setNotFound, setOnNavigate, start, navigate, resolve } from './router.js';
import { isAdmin, ADMIN_ROUTES, subscribe, setCampaign } from './state.js';
import { checkConnection, getReference } from './api.js';

const main = mountShell(document.getElementById('root'));

/** Wrap a page renderer: guards admin routes and surfaces load failures. */
function page(loader, { admin = false } = {}) {
  return async (route) => {
    if (admin && !isAdmin()) {
      replace(main, errorState({
        title: 'Administrator access required',
        note: 'This section contains integration settings and credentials. Switch to the Admin role to view it.',
        retry: () => navigate('dashboard'),
      }));
      return;
    }
    main.scrollTop = 0;
    try {
      const render = await loader();
      await render(main, route);
      // A screen may have fallen back to sample data while rendering.
      renderConnection();
    } catch (err) {
      // Never surface a stack trace to an operator (PRD §14).
      console.error(err);
      replace(main, errorState({
        title: 'This screen could not be loaded',
        note: 'The interface hit an unexpected problem. Your data is unaffected — reloading usually resolves it.',
        retry: () => start(),
      }));
    }
  };
}

register('dashboard', page(async () => (await import('./pages/dashboard.js')).renderDashboard));

register('leads', page(async () => {
  const [{ renderLeads }, { renderLeadDetail }] = await Promise.all([
    import('./pages/leads.js'),
    import('./pages/leadDetail.js'),
  ]);
  // `#/leads` lists; `#/leads/:id` opens the detail view.
  return (root, route) => (route.params[0]
    ? renderLeadDetail(root, route.params[0])
    : renderLeads(root, route));
}));

register('unresolved', page(async () => (await import('./pages/unresolved.js')).renderUnresolved));
register('duplicates', page(async () => (await import('./pages/duplicates.js')).renderDuplicates));
register('analytics',  page(async () => (await import('./pages/analytics.js')).renderAnalytics));
register('logs',       page(async () => (await import('./pages/logs.js')).renderLogs));

register('campaign',     page(async () => (await import('./pages/admin/campaign.js')).renderCampaign, { admin: true }));
register('channels',     page(async () => (await import('./pages/admin/channels.js')).renderChannels, { admin: true }));
register('users',        page(async () => (await import('./pages/admin/users.js')).renderUsers, { admin: true }));
register('integrations', page(async () => (await import('./pages/admin/system.js')).renderIntegrations, { admin: true }));
register('diagnostics',  page(async () => (await import('./pages/admin/system.js')).renderDiagnostics, { admin: true }));

setNotFound((route) => {
  replace(main, errorState({
    title: 'Page not found',
    note: `No screen matches “${route.name}”.`,
    retry: () => navigate('dashboard'),
  }));
});

// Keep the sidebar's active state in sync with the URL.
setOnNavigate(() => renderSidebar());

// Re-render navigation when the role changes (Admin sections appear/disappear).
subscribe(() => renderSidebar());

start();

// Probe the service so the header reflects whether live data is flowing, then
// adopt the campaign name it reports — the UI must not assert a campaign of its
// own, or the header keeps showing a name the service no longer uses.
checkConnection().then(async () => {
  renderConnection();
  try {
    const ref = await getReference();
    if (setCampaign(ref?.campaign?.exhibition)) {
      renderCampaign();
      resolve();   // repaint the current page, whose title may show it
    }
  } catch {
    /* Offline or unauthenticated: the placeholder stays, nothing is invented. */
  }
});
