/**
 * Hash router.
 *
 * Hash-based so the app is a single static file set with no server rewrite
 * rules — matching the project's no-build convention. Routes are matched by
 * their first segment; the remainder is passed to the page as params.
 *
 *   #/leads            → { name: 'leads',  params: [] }
 *   #/leads/lead-351   → { name: 'leads',  params: ['lead-351'] }
 *   #/leads?status=failed → query is parsed into `query`
 */

const routes = new Map();
let notFound = null;
let onNavigate = null;

export function register(name, handler) {
  routes.set(name, handler);
}

export function setNotFound(handler) { notFound = handler; }
export function setOnNavigate(fn) { onNavigate = fn; }

export function parseHash(hash = location.hash) {
  const raw = hash.replace(/^#\/?/, '');
  const [pathPart, queryPart] = raw.split('?');
  const segments = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
  const query = Object.fromEntries(new URLSearchParams(queryPart || ''));
  return { name: segments[0] || 'dashboard', params: segments.slice(1), query };
}

export function navigate(path, { replace = false } = {}) {
  const target = path.startsWith('#') ? path : `#/${path.replace(/^\/+/, '')}`;
  if (location.hash === target) {
    resolve();
    return;
  }
  if (replace) history.replaceState(null, '', target);
  else location.hash = target;
}

/** Current route, useful for highlighting navigation. */
export function current() { return parseHash(); }

export function resolve() {
  const route = parseHash();
  const handler = routes.get(route.name) || notFound;
  onNavigate?.(route);
  handler?.(route);
}

export function start() {
  window.addEventListener('hashchange', resolve);
  if (!location.hash) history.replaceState(null, '', '#/dashboard');
  resolve();
}
