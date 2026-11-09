import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  CORS_ORIGIN: z.string().min(1),
  REDIS_URL: z.string().url().optional(),
  TRUST_PROXY: z.coerce.number().int().min(0).default(1),
  BOOKING_LIMIT_PER_IP: z.coerce.number().int().positive().default(5),
  BOOKING_LIMIT_PER_IP_WINDOW_SEC: z.coerce.number().int().positive().default(600),
  BOOKING_LIMIT_PER_PHONE: z.coerce.number().int().positive().default(3),
  BOOKING_LIMIT_PER_PHONE_WINDOW_SEC: z.coerce.number().int().positive().default(3600),
  READ_LIMIT_PER_IP_PER_MIN: z.coerce.number().int().positive().default(120),
  // --- panel admina ---
  JWT_SECRET: z.string().min(32, 'JWT_SECRET: min. 32 znaki (np. openssl rand -base64 48)'),
  CSRF_SECRET: z.string().min(32, 'CSRF_SECRET: min. 32 znaki'),
  ACCESS_TOKEN_TTL_MIN: z.coerce.number().int().min(1).max(60).default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(14),
  // w produkcji zawsze true; false tylko dla http://localhost w developmencie
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  LOGIN_LIMIT_PER_IP: z.coerce.number().int().positive().default(10),
  LOGIN_MAX_FAILED_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().positive().default(15),
  // --- powiadomienia / integracje ---
  BUSINESS_NAME: z.string().min(1).default('Serwis'),
  BUSINESS_PHONE: z.string().max(30).optional(),
  BUSINESS_ADDRESS: z.string().max(200).optional(),
  // cloud = WhatsApp Cloud API (Meta) | log = tylko logi (development) | disabled
  WHATSAPP_MODE: z.enum(['cloud', 'log', 'disabled']).default('log'),
  WHATSAPP_API_BASE_URL: z.string().url().default('https://graph.facebook.com'),
  WHATSAPP_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v24.0'),
  WHATSAPP_PHONE_NUMBER_ID: z.string().regex(/^\d+$/).optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().min(20).optional(),   // token System User (bezterminowy)
  WHATSAPP_APP_SECRET: z.string().min(16).optional(),     // weryfikacja podpisu webhooków
  WHATSAPP_VERIFY_TOKEN: z.string().min(16).optional(),   // weryfikacja adresu webhooka
  WHATSAPP_TEMPLATE_LANGUAGE: z.string().default('pl'),
  // api = Google Calendar API (Service Account) | log | disabled
  GOOGLE_CALENDAR_MODE: z.enum(['api', 'log', 'disabled']).default('log'),
  GOOGLE_API_BASE_URL: z.string().url().default('https://www.googleapis.com'),
  GOOGLE_SERVICE_ACCOUNT_KEY_FILE: z.string().optional(),
  GOOGLE_CALENDAR_ID: z.string().optional(),
  // RODO: domyślnie bez imienia i telefonu klienta w kalendarzu Google
  GOOGLE_CALENDAR_INCLUDE_PII: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
}).superRefine((e, ctx) => {
  if (e.WHATSAPP_MODE === 'cloud') {
    for (const k of ['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN'] as const) {
      if (!e[k]) ctx.addIssue({ code: 'custom', path: [k], message: `${k} wymagany przy WHATSAPP_MODE=cloud` });
    }
  }
  if (e.GOOGLE_CALENDAR_MODE === 'api') {
    for (const k of ['GOOGLE_SERVICE_ACCOUNT_KEY_FILE', 'GOOGLE_CALENDAR_ID'] as const) {
      if (!e[k]) ctx.addIssue({ code: 'custom', path: [k], message: `${k} wymagany przy GOOGLE_CALENDAR_MODE=api` });
    }
  }
});

// Puste zmienne (np. `WHATSAPP_TOKEN=` z .env / docker compose) traktujemy jak nieustawione
const rawEnv = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined && v !== ''));
const parsed = EnvSchema.safeParse(rawEnv);
if (!parsed.success) {
  console.error('Niepoprawna konfiguracja środowiska:', z.treeifyError(parsed.error));
  process.exit(1);
}
export const config = {
  ...parsed.data,
  cookieSecure: parsed.data.COOKIE_SECURE ? parsed.data.COOKIE_SECURE === 'true' : parsed.data.NODE_ENV === 'production',
  allowedOrigins: parsed.data.CORS_ORIGIN.split(',').map((o) => o.trim()),
};
if (config.NODE_ENV === 'production' && !config.cookieSecure) {
  console.error('COOKIE_SECURE=false jest niedozwolone w produkcji.');
  process.exit(1);
}

if (config.NODE_ENV === 'production' && !config.REDIS_URL) {
  console.error('REDIS_URL jest wymagany w produkcji (rate limiting między instancjami).');
  process.exit(1);
}
