/**
 * Tiny observable app state.
 *
 * Holds only what is genuinely global: the active role (which controls whether
 * Admin sections exist at all) and the campaign shown in the top bar.
 * Page-local concerns like filters and sorting stay inside their page module.
 */

const listeners = new Set();

export const state = {
  /**
   * The signed-in account, as reported by the service. The role is NOT a
   * client-side choice: it is stored on the account and enforced on every
   * request, so hiding a screen here is convenience, not security.
   */
  user: null,
  /** 'admin' | 'user', mirrored from the account for convenience. */
  role: 'user',
  /**
   * Campaign name shown in the top bar. Owned by the SERVICE (CAMPAIGN_
   * EXHIBITION), not by the UI — it is filled in on boot from the reference
   * endpoint. The placeholder only shows for the moment before that returns.
   */
  campaign: '—',
};

/** Adopt the campaign name the service reports. */
export function setCampaign(name) {
  if (!name || state.campaign === name) return false;
  state.campaign = name;
  return true;
}

export const isAdmin = () => state.role === 'admin';
export const isSignedIn = () => state.user != null;

/** Adopt the account the service reports. Never called with client-made data. */
export function setUser(user) {
  state.user = user ?? null;
  state.role = user?.role === 'admin' ? 'admin' : 'user';
  emit();
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) fn(state);
}

/** Routes only an administrator may open. */
export const ADMIN_ROUTES = new Set(['campaign', 'channels', 'users', 'integrations', 'diagnostics', 'logs']);
