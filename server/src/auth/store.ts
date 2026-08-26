/**
 * Accounts and login sessions.
 *
 * The console previously had a single shared secret and a *demo* role switcher
 * in the header — anyone with the secret was effectively an administrator, and
 * the role was a client-side display choice. This store makes identity and role
 * real: the role lives on the account, is resolved server-side from the session,
 * and the browser cannot influence it.
 */

import type { Db } from '../db/index.js';
import { hashPassword, verifyPassword, newSessionToken, hashToken } from './passwords.js';

export type Role = 'admin' | 'user';

export interface AccountRow {
  id: number;
  username: string;
  display_name: string | null;
  role: Role;
  password_hash: string;
  password_salt: string;
  disabled: number;
  created_at: string;
  last_login_at: string | null;
}

/** What the rest of the app is allowed to see — never the password material. */
export interface Account {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

/** Session lifetime. Short enough to limit a stolen token, long enough for a shift. */
const SESSION_HOURS = 12;

function toAccount(r: AccountRow): Account {
  return {
    id: r.id,
    username: r.username,
    displayName: r.display_name ?? r.username,
    role: r.role === 'admin' ? 'admin' : 'user',
    disabled: r.disabled === 1,
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at,
  };
}

export class AuthStore {
  constructor(private readonly db: Db) {}

  // ── accounts ────────────────────────────────────────────────

  count(): number {
    const r = this.db.handle.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    return r.n;
  }

  list(): Account[] {
    const rows = this.db.handle
      .prepare('SELECT * FROM users ORDER BY role, username')
      .all() as unknown as AccountRow[];
    return rows.map(toAccount);
  }

  findByUsername(username: string): AccountRow | null {
    const row = this.db.handle
      .prepare('SELECT * FROM users WHERE username = ?')
      .get(username.trim().toLowerCase()) as unknown as AccountRow | undefined;
    return row ?? null;
  }

  /** Create an account. Usernames are stored lower-case so login is case-insensitive. */
  create(opts: { username: string; password: string; role: Role; displayName?: string }): Account {
    const { hash, salt } = hashPassword(opts.password);
    this.db.handle
      .prepare(
        `INSERT INTO users (username, display_name, role, password_hash, password_salt)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        opts.username.trim().toLowerCase(),
        opts.displayName ?? opts.username,
        opts.role,
        hash,
        salt,
      );
    return toAccount(this.findByUsername(opts.username)!);
  }

  setPassword(userId: number, password: string): void {
    const { hash, salt } = hashPassword(password);
    this.db.handle
      .prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?')
      .run(hash, salt, userId);
    // Changing a password invalidates every existing session for that user:
    // otherwise a stolen session survives the very action taken to stop it.
    this.revokeAllForUser(userId);
  }

  setRole(userId: number, role: Role): void {
    this.db.handle.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);
    // The role is carried by the session lookup, so existing sessions would
    // keep the old privileges until they expire. Force a fresh login.
    this.revokeAllForUser(userId);
  }

  setDisabled(userId: number, disabled: boolean): void {
    this.db.handle.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, userId);
    if (disabled) this.revokeAllForUser(userId);
  }

  // ── login ───────────────────────────────────────────────────

  /**
   * Verify credentials and open a session. Returns null for a wrong password,
   * an unknown user, or a disabled account — deliberately the same result, so
   * the response cannot be used to enumerate valid usernames.
   */
  login(username: string, password: string): { token: string; account: Account } | null {
    const row = this.findByUsername(username);
    if (!row || row.disabled === 1) {
      // Spend comparable time on an unknown user so timing does not reveal
      // whether the account exists.
      verifyPassword(password, { hash: 'ff'.repeat(64), salt: 'decoy' });
      return null;
    }
    if (!verifyPassword(password, { hash: row.password_hash, salt: row.password_salt })) return null;

    const token = newSessionToken();
    const expires = new Date(Date.now() + SESSION_HOURS * 3600_000).toISOString();
    this.db.handle
      .prepare('INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(hashToken(token), row.id, expires);
    this.db.handle
      .prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`)
      .run(row.id);

    return { token, account: toAccount(row) };
  }

  /** Resolve a session token to its account, or null when invalid/expired. */
  resolve(token: string | null): Account | null {
    if (!token) return null;
    const row = this.db.handle
      .prepare(
        `SELECT u.* FROM auth_sessions s
           JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = ? AND s.expires_at > datetime('now') AND u.disabled = 0`,
      )
      .get(hashToken(token)) as unknown as AccountRow | undefined;
    return row ? toAccount(row) : null;
  }

  revoke(token: string): void {
    this.db.handle.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(hashToken(token));
  }

  revokeAllForUser(userId: number): void {
    this.db.handle.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(userId);
  }

  /** Housekeeping: drop expired rows so the table cannot grow without bound. */
  purgeExpired(): void {
    this.db.handle.prepare(`DELETE FROM auth_sessions WHERE expires_at <= datetime('now')`).run();
  }
}
