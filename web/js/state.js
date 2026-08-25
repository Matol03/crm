/**
 * Tiny observable app state.
 *
 * Holds only what is genuinely global: the active role (which controls whether
 * Admin sections exist at all) and the campaign shown in the top bar.
 * Page-local concerns like filters and sorting stay inside their page module.
 */

const KEY = 'leadservice.role';

const listeners = new Set();

export const state = {
  /** 'admin' | 'user' — demo switcher; the API is the real authority. */
  role: localStorage.getItem(KEY) === 'user' ? 'user' : 'admin',
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

export function setRole(role) {
  if (state.role === role) return;
  state.role = role;
  localStorage.setItem(KEY, role);
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
export const ADMIN_ROUTES = new Set(['campaign', 'channels', 'users', 'integrations', 'diagnostics']);
