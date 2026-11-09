/**
 * Rejestruje wersję dokumentu prawnego (regulamin / polityka prywatności / zgoda marketingowa).
 *   npm run legal:publish -- --kind terms --version 1.0 --url https://twojadomena.pl/regulamin --file ./regulamin.txt
 * Dla --kind whatsapp treść (--text/--file) to krótki tekst zgody pokazywany przy checkboxie w formularzu.
 * Zapisuje SHA-256 treści jako dowód, jaką wersję zaakceptował klient. Nową wersję publikuje się nowym numerem.
 */
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import pg from 'pg';

const { values } = parseArgs({ options: {
  kind: { type: 'string' }, version: { type: 'string' }, url: { type: 'string' },
  file: { type: 'string' }, text: { type: 'string' },
} });
const args = z.object({
  kind: z.enum(['terms', 'privacy', 'marketing', 'whatsapp']),
  version: z.string().min(1).max(20),
  url: z.url(),
}).parse(values);
if (!values.file && !values.text) throw new Error('Podaj --file <plik> albo --text "<treść>"');
const content = values.file ? await readFile(values.file, 'utf8') : values.text!;
const sha = createHash('sha256').update(content, 'utf8').digest();

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query(
    'INSERT INTO legal_documents (kind, version, content_sha256, url, display_text) VALUES ($1,$2,$3,$4,$5)',
    // zgoda WhatsApp: treść zgody jest wyświetlana przy checkboxie, więc zapisujemy ją też jako display_text
    [args.kind, args.version, sha, args.url, args.kind === 'whatsapp' ? content : null],
  );
  console.log(`Opublikowano ${args.kind} v${args.version} (sha256 ${sha.toString('hex').slice(0, 16)}…)`);
} catch (e) {
  if ((e as { code?: string }).code === '23505') { console.error(`Wersja ${args.version} dokumentu ${args.kind} już istnieje.`); process.exitCode = 1; }
  else throw e;
} finally { await client.end(); }
