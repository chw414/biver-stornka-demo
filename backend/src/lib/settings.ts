import { z } from 'zod';
import { pool } from '../db.js';

export const PriceInfoSchema = z.object({
  note: z.string().max(300).optional(),
  groupNotes: z.record(z.string(), z.string().max(200)).default({}),
  items: z.array(z.object({ label: z.string().max(80), price: z.string().max(80) })).max(40).default([]),
});
export type PriceInfo = z.infer<typeof PriceInfoSchema>;

const SettingsSchema = z.object({
  timezone: z.string().default('Europe/Warsaw'),
  slot_minutes: z.number().int().default(15),
  booking_horizon_days: z.number().int().positive().default(60),
  min_lead_time_minutes: z.number().int().min(0).default(60),
  reminder_offset_hours: z.number().int().positive().default(24),
  phone_verification: z.enum(['none', 'sms_otp']).default('none'),
  notification_channels: z.array(z.enum(['whatsapp', 'sms'])).min(1).default(['whatsapp']),
  price_info: PriceInfoSchema.optional(),
});
export type Settings = z.infer<typeof SettingsSchema>;

let cache: { value: Settings; expiresAt: number } | null = null;
const TTL_MS = 60_000;

export async function getSettings(): Promise<Settings> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;
  const { rows } = await pool.query<{ key: string; value: unknown }>('SELECT key, value FROM app_settings');
  const value = SettingsSchema.parse(Object.fromEntries(rows.map((r) => [r.key, r.value])));
  cache = { value, expiresAt: Date.now() + TTL_MS };
  return value;
}

export function invalidateSettingsCache(): void {
  cache = null;
}
