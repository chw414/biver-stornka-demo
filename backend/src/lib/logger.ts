import { pino } from 'pino';

// Dane osobowe nie trafiają do logów (RODO)
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: ['req.body', '*.phone', '*.fullName', '*.registrationNumber', '*.phone_e164', 'err.parameters'],
    censor: '[REDACTED]',
  },
});
