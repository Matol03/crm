/**
 * Sign-in screen.
 *
 * Shown instead of the console when nobody is signed in. Deliberately plain:
 * it states one thing, asks for two, and reports failure in one message —
 * "wrong username or password" — because naming which half was wrong tells an
 * attacker which usernames exist.
 */

import { h, replace } from '../ui/dom.js';
import { login } from '../api.js';

export function renderLogin(root, onSignedIn) {
  let error;
  let busy = false;

  const username = h('input.input#login-username', {
    type: 'text', autocomplete: 'username', spellcheck: 'false', placeholder: 'your username',
  });
  const password = h('input.input#login-password', {
    type: 'password', autocomplete: 'current-password', placeholder: 'your password',
  });

  const submit = async (ev) => {
    ev?.preventDefault?.();
    if (busy) return;
    const u = username.value.trim();
    const p = password.value;
    if (!u || !p) {
      showError('Enter your username and password.');
      (u ? password : username).focus();
      return;
    }
    busy = true;
    button.disabled = true;
    button.textContent = 'Signing in…';
    try {
      const user = await login(u, p);
      onSignedIn(user);
    } catch (err) {
      busy = false;
      button.disabled = false;
      button.textContent = 'Sign in';
      password.value = '';
      password.focus();
      showError(err?.message || 'Sign-in failed.');
    }
  };

  function showError(msg) {
    error.textContent = '';
    error.appendChild(
      h('div.banner.banner-warn',
        h('div', h('div.fw-medium', 'Not signed in'),
          h('div.t-xs', { style: { marginTop: '2px' } }, msg))));
  }

  const button = h('button.btn.btn-primary', { type: 'submit' }, 'Sign in');

  const form = h('form.stack-4', { onsubmit: submit },
    h('div',
      h('label.field-label', { for: 'login-username' }, 'Username'),
      username),
    h('div',
      h('label.field-label', { for: 'login-password' }, 'Password'),
      password),
    (error = h('div')),
    h('div.row', { style: { justifyContent: 'flex-end' } }, button));

  replace(root,
    h('div', {
      style: {
        minHeight: '100vh', display: 'grid', placeItems: 'center',
        padding: 'var(--sp-5)',
      },
    },
      h('div', { style: { width: '100%', maxWidth: '380px' } },
        h('div', { style: { marginBottom: 'var(--sp-5)' } },
          h('h1', { style: { fontSize: '20px', margin: 0 } }, 'LeadStream'),
          h('p.t-sm.muted', { style: { marginTop: '4px' } },
            'Sign in to see the leads collected from Teams.')),
        h('div.panel', h('div.panel-body', form)))));

  username.focus();
}
