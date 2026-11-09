/**
 * Proces workera (osobny od API): npm run worker
 * - wysyłka powiadomień (WhatsApp; miejsce na SMS),
 * - synchronizacja Google Calendar z outboxa.
 * Źródłem prawdy jest PostgreSQL — restart workera niczego nie gubi. Można uruchomić kilka instancji.
 */
import { config } from './config.js';
import { pool } from './db.js';
import { logger } from './lib/logger.js';
import { invalidateSettingsCache } from './lib/settings.js';
import { buildChannelRegistry } from './notifications/channels/registry.js';
import { runNotificationTick } from './notifications/notification.worker.js';
import { GoogleCalendarClient } from './calendar/googleCalendar.client.js';
import { runOutboxTick, type CalendarTarget } from './calendar/outbox.worker.js';

const IDLE_MS = 5_000;
let stopping = false;

const channels = buildChannelRegistry();
const calendar: CalendarTarget = config.GOOGLE_CALENDAR_MODE === 'api'
  ? await GoogleCalendarClient.fromServiceAccount(config.GOOGLE_SERVICE_ACCOUNT_KEY_FILE!, config.GOOGLE_CALENDAR_ID!, config.GOOGLE_API_BASE_URL)
  : config.GOOGLE_CALENDAR_MODE;

logger.info({ channels: [...channels.keys()], calendar: config.GOOGLE_CALENDAR_MODE }, 'Worker uruchomiony');

async function loop(name: string, tick: () => Promise<number>) {
  while (!stopping) {
    let processed = 0;
    try {
      processed = await tick();
    } catch (err) {
      logger.error({ err, loop: name }, 'Błąd pętli workera');
    }
    // pełna paczka → od razu następna; pusto → krótka przerwa
    if (processed === 0 && !stopping) await new Promise((r) => setTimeout(r, IDLE_MS));
  }
}

const settingsRefresh = setInterval(invalidateSettingsCache, 60_000);
const loops = Promise.all([
  loop('notifications', () => runNotificationTick(channels)),
  loop('calendar', () => runOutboxTick(calendar)),
]);

async function shutdown(signal: string) {
  logger.info(`${signal} — kończę bieżące paczki`);
  stopping = true;
  clearInterval(settingsRefresh);
  await loops;
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
