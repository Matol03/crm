/**
 * Map a Teams author to a Bitrix user (PRD Section 10.5).
 *
 * Ownership follows whoever posted the message, which needs this mapping;
 * without it every lead falls back to the default owner and is flagged.
 *
 *   tsx scripts/map-user.ts <teams-email> <bitrix-user-id> [display name]
 *   tsx scripts/map-user.ts --list
 */

import { loadConfig } from '../server/src/config/index.js';
import { Db } from '../server/src/db/index.js';

function main(): void {
  const cfg = loadConfig();
  const db = new Db(process.env.DB_PATH ?? cfg.dbPath);
  const args = process.argv.slice(2);

  if (!args.length || args[0] === '--list') {
    const rows = db.handle
      .prepare('SELECT teams_email, bitrix_user_id, display_name FROM employee_map ORDER BY teams_email')
      .all() as Array<{ teams_email: string; bitrix_user_id: number; display_name: string | null }>;
    console.log(rows.length ? 'Mapped Teams identities:' : 'No Teams identities are mapped.');
    for (const r of rows) {
      console.log(`  ${r.teams_email}  ->  Bitrix #${r.bitrix_user_id}${r.display_name ? ` (${r.display_name})` : ''}`);
    }
    return;
  }

  const [email, idRaw, ...nameParts] = args;
  const bitrixUserId = Number(idRaw);
  if (!email || !Number.isFinite(bitrixUserId)) {
    console.error('usage: tsx scripts/map-user.ts <teams-email> <bitrix-user-id> [display name]');
    process.exit(1);
  }

  // Emails are compared lower-case elsewhere, so store them that way.
  db.setEmployee(email.toLowerCase(), bitrixUserId, nameParts.join(' ') || email);
  console.log(`mapped ${email.toLowerCase()} -> Bitrix #${bitrixUserId}`);
}

main();
