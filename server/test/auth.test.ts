import { describe, it, expect } from 'vitest';
import { Db } from '../src/db/index.js';
import { AuthStore } from '../src/auth/store.js';
import { hashPassword, verifyPassword, passwordProblem, hashToken } from '../src/auth/passwords.js';

const freshDb = () => new Db(':memory:');

describe('password handling', () => {
  it('never stores the password and verifies the right one', () => {
    const rec = hashPassword('correct horse battery');
    expect(rec.hash).not.toContain('correct');
    expect(verifyPassword('correct horse battery', rec)).toBe(true);
    expect(verifyPassword('wrong password here', rec)).toBe(false);
  });

  it('salts each password, so identical passwords hash differently', () => {
    const a = hashPassword('same-password-1');
    const b = hashPassword('same-password-1');
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });

  it('rejects a malformed record rather than throwing', () => {
    expect(verifyPassword('x', { hash: '', salt: '' })).toBe(false);
    expect(verifyPassword('x', { hash: 'zz', salt: 'q' })).toBe(false);
  });

  it('enforces a minimum password policy', () => {
    expect(passwordProblem('short1')).toMatch(/10 characters/);
    expect(passwordProblem('nodigitshere')).toMatch(/digit/);
    expect(passwordProblem('goodpassword1')).toBeNull();
  });
});

describe('accounts and sessions', () => {
  it('signs in with the right password and rejects the wrong one', () => {
    const db = freshDb();
    const auth = new AuthStore(db);
    auth.create({ username: 'Manager', password: 'goodpassword1', role: 'user' });

    expect(auth.login('manager', 'wrongpassword1')).toBeNull();
    const ok = auth.login('MANAGER', 'goodpassword1');   // login is case-insensitive
    expect(ok).not.toBeNull();
    expect(ok!.account.role).toBe('user');
    db.close();
  });

  it('returns null for an unknown user, exactly as for a wrong password', () => {
    const db = freshDb();
    expect(new AuthStore(db).login('nobody', 'goodpassword1')).toBeNull();
    db.close();
  });

  it('stores only a hash of the session token', () => {
    const db = freshDb();
    const auth = new AuthStore(db);
    auth.create({ username: 'a', password: 'goodpassword1', role: 'admin' });
    const { token } = auth.login('a', 'goodpassword1')!;

    const rows = db.handle.prepare('SELECT token_hash FROM auth_sessions').all() as Array<{ token_hash: string }>;
    expect(rows[0]!.token_hash).toBe(hashToken(token));
    // A leaked database must not hand over usable tokens.
    expect(rows[0]!.token_hash).not.toBe(token);
    db.close();
  });

  it('resolves a session to its account and forgets it on logout', () => {
    const db = freshDb();
    const auth = new AuthStore(db);
    auth.create({ username: 'a', password: 'goodpassword1', role: 'admin' });
    const { token } = auth.login('a', 'goodpassword1')!;

    expect(auth.resolve(token)!.role).toBe('admin');
    auth.revoke(token);
    expect(auth.resolve(token)).toBeNull();
    db.close();
  });

  it('revokes existing sessions when the role changes', () => {
    // Otherwise a demoted administrator keeps administrator access until the
    // session happens to expire.
    const db = freshDb();
    const auth = new AuthStore(db);
    const acc = auth.create({ username: 'a', password: 'goodpassword1', role: 'admin' });
    const { token } = auth.login('a', 'goodpassword1')!;

    auth.setRole(acc.id, 'user');
    expect(auth.resolve(token)).toBeNull();
    db.close();
  });

  it('revokes sessions when the password changes or the account is disabled', () => {
    const db = freshDb();
    const auth = new AuthStore(db);
    const acc = auth.create({ username: 'a', password: 'goodpassword1', role: 'user' });

    let token = auth.login('a', 'goodpassword1')!.token;
    auth.setPassword(acc.id, 'anotherpassword2');
    expect(auth.resolve(token)).toBeNull();

    token = auth.login('a', 'anotherpassword2')!.token;
    auth.setDisabled(acc.id, true);
    expect(auth.resolve(token)).toBeNull();
    expect(auth.login('a', 'anotherpassword2')).toBeNull();
    db.close();
  });

  it('treats an expired session as signed out', () => {
    const db = freshDb();
    const auth = new AuthStore(db);
    auth.create({ username: 'a', password: 'goodpassword1', role: 'user' });
    const { token } = auth.login('a', 'goodpassword1')!;

    db.handle.prepare(`UPDATE auth_sessions SET expires_at = datetime('now','-1 hour')`).run();
    expect(auth.resolve(token)).toBeNull();
    db.close();
  });
});
