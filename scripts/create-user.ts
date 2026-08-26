/**
 * Create or update a console account.
 *
 * Bootstrap path: the very first administrator is created here, from the
 * machine that runs the service, because there is no one to log in as yet.
 *
 * Usage:
 *   npx tsx scripts/create-user.ts <username> <role: admin|user> [display name]
 *
 * The password is NOT taken from the command line — it would end up in shell
 * history and in the process list. It is read from the PASSWORD environment
 * variable, or generated and printed once.
 */

import { randomBytes } from 'node:crypto';
import { loadConfig } from '../server/src/config/index.js';
import { Db } from '../server/src/db/index.js';
import { AuthStore } from '../server/src/auth/store.js';
import { passwordProblem } from '../server/src/auth/passwords.js';

const [username, roleArg, ...rest] = process.argv.slice(2);
if (!username || (roleArg !== 'admin' && roleArg !== 'user')) {
  console.error('usage: npx tsx scripts/create-user.ts <username> <admin|user> [display name]');
  process.exit(1);
}

const cfg = loadConfig();
const db = new Db(cfg.dbPath);
const auth = new AuthStore(db);

const password = process.env['PASSWORD'] ?? randomBytes(12).toString('base64url');
const problem = passwordProblem(password);
if (problem) {
  console.error(problem);
  process.exit(1);
}

const existing = auth.findByUsername(username);
if (existing) {
  auth.setPassword(existing.id, password);
  auth.setRole(existing.id, roleArg);
  console.log(`updated account "${username}" (role: ${roleArg}); existing sessions revoked`);
} else {
  auth.create({ username, password, role: roleArg, displayName: rest.join(' ') || username });
  console.log(`created account "${username}" (role: ${roleArg})`);
}

if (!process.env['PASSWORD']) {
  console.log('\ngenerated password (shown once — store it in a password manager):');
  console.log('   ' + password);
}
db.close();
