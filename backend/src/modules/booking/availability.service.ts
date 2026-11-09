import { pool } from '../../db.js';
import { getSettings } from '../../lib/settings.js';
import { Errors } from '../../errors.js';
import { addDays, findSlots, localDates } from './availability.repository.js';
import { getPublicService } from './services.repository.js';

const MAX_RANGE_DAYS = 62;

/** Przycina zakres dat do [dziś, dziś + horyzont]. null = zakres całkowicie poza oknem rezerwacji. */
async function clampRange(from: string, to: string) {
  const s = await getSettings();
  const { today } = await localDates(pool, s.timezone);
  const lastDay = addDays(today, s.booking_horizon_days);
  const f = from < today ? today : from;
  const t = to > lastDay ? lastDay : to;
  return { settings: s, range: f <= t ? { from: f, to: t } : null };
}

export async function getSlotsForDay(serviceId: number, date: string) {
  const service = await getPublicService(pool, serviceId);
  if (!service) throw Errors.serviceNotFound();
  const { settings, range } = await clampRange(date, date);
  if (!range) return { date, timezone: settings.timezone, slots: [] };

  const rows = await findSlots(pool, {
    ...range,
    durationMin: service.duration_minutes,
    timezone: settings.timezone,
    leadMin: settings.min_lead_time_minutes,
  });
  return {
    date,
    timezone: settings.timezone,
    // klient widzi tylko CZY termin jest wolny — liczba i numery stanowisk to szczegół wewnętrzny
    slots: rows
      .filter((r) => r.free_station_ids.length > 0)
      .map((r) => ({ startsAt: r.starts_at.toISOString(), endsAt: r.ends_at.toISOString() })),
  };
}

/** Dni z przynajmniej jednym wolnym slotem — do wyszarzania dni w kalendarzu na froncie. */
export async function getAvailableDays(serviceId: number, from: string, to: string) {
  const service = await getPublicService(pool, serviceId);
  if (!service) throw Errors.serviceNotFound();
  const { settings, range } = await clampRange(from, to < addDays(from, MAX_RANGE_DAYS) ? to : addDays(from, MAX_RANGE_DAYS));
  if (!range) return { timezone: settings.timezone, days: [] };

  const rows = await findSlots(pool, {
    ...range,
    durationMin: service.duration_minutes,
    timezone: settings.timezone,
    leadMin: settings.min_lead_time_minutes,
  });
  const days = [...new Set(rows.filter((r) => r.free_station_ids.length > 0).map((r) => r.day))];
  return { timezone: settings.timezone, days };
}
