/**
 * Zakłada konto administratora.
 *   npm run admin:create -- --email jan@serwis.pl --name "Jan Kowalski" --role owner
 * Hasło: wpisywane bez echa (nie trafia do historii powłoki). Dla CI: zmienna ADMIN_PASSWORD.
 */
import { parseArgs } from 'node:util';
import { z } from 'zod';
import pg from 'pg';
import { hashPassword, PasswordPolicy } from '../src/modules/auth/password.js';

const { values } = parseArgs({ options: { email: { type: 'string' }, name: { type: 'string' }, role: { type: 'string', default: 'staff' } } });
const args = z.object({
  email: z.email().transform((e) => e.toLowerCase()),
  name: z.string().min(2).max(120),
  role: z.enum(['owner', 'staff']),
}).parse(values);

async function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error('Brak terminala — ustaw ADMIN_PASSWORD');
  process.stdout.write(question);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let input = '';
  return new Promise((resolve) => {
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', onData);
          process.stdout.write('\n'); return resolve(input);
        }
        if (ch === '\u0003') process.exit(130);            // Ctrl+C
        if (ch === '\u007f') input = input.slice(0, -1);   // Backspace
        else input += ch;
      }
    };
    process.stdin.on('data', onData);
  });
}

let password = process.env.ADMIN_PASSWORD;
if (!password) {
  password = await promptHidden('Hasło (min. 12 znaków): ');
  if (password !== (await promptHidden('Powtórz hasło: '))) { console.error('Hasła się różnią'); process.exit(1); }
}
PasswordPolicy.parse(password);

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  const { rows: [a] } = await db.query<{ id: string }>(
    `INSERT INTO admins (email, password_hash, full_name, role) VALUES ($1, $2, $3, $4) RETURNING id`,
    [args.email, await hashPassword(password), args.name, args.role]);
  console.log(`Utworzono konto ${args.role}: ${args.email} (${a!.id})`);
} catch (e) {
  if ((e as { code?: string }).code === '23505') { console.error('Konto z tym e-mailem już istnieje'); process.exit(1); }
  throw e;
} finally {
  await db.end();
}
