import { config } from './config.js';
import { createApp } from './app.js';
import { pool } from './db.js';
import { logger } from './lib/logger.js';

const server = createApp().listen(config.PORT, () => logger.info(`API na porcie ${config.PORT}`));

async function shutdown(signal: string) {
  logger.info(`${signal} — zamykanie`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
