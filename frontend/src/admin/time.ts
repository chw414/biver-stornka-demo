/** Operacje na czasie w strefie serwisu (Europe/Warsaw), niezależnie od strefy komputera admina. */
export const TZ = 'Europe/Warsaw';

const partsFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function parts(d: Date) {
  const p = Object.fromEntries(partsFmt.formatToParts(d).map((x) => [x.type, x.value]));
  return { y: +p.year!, mo: +p.month!, d: +p.day!, h: +p.hour!, mi: +p.minute!, s: +p.second! };
}

/** "2026-10-12" + "09:30" w strefie serwisu → Date (poprawnie przy zmianie czasu). */
export function zonedToDate(day: string, time: string): Date {
  const [y, mo, d] = day.split('-').map(Number) as [number, number, number];
  const [h, mi] = time.split(':').map(Number) as [number, number];
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  let guess = asUtc;
  for (let i = 0; i < 2; i++) {
    const p = parts(new Date(guess));
    const offset = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - guess;
    guess = asUtc - offset;
  }
  return new Date(guess);
}

/** Minuty od północy (czas lokalny serwisu). */
export const minutesOfDay = (iso: string | Date) => { const p = parts(new Date(iso)); return p.h * 60 + p.mi; };
/** "2026-10-12" (czas lokalny serwisu). */
export const dayOf = (iso: string | Date) => { const p = parts(new Date(iso)); return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; };
export const todayIso = () => dayOf(new Date());

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** Poniedziałek tygodnia, w którym jest `day`. */
export function weekStart(day: string): string {
  const dow = (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(day, -dow);
}

const fTime = new Intl.DateTimeFormat('pl-PL', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const fDayLong = new Intl.DateTimeFormat('pl-PL', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
const fWeekday = new Intl.DateTimeFormat('pl-PL', { timeZone: 'UTC', weekday: 'short' });
const fDateTime = new Intl.DateTimeFormat('pl-PL', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const fDate = new Intl.DateTimeFormat('pl-PL', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' });

export const fmtTime = (iso: string | Date) => fTime.format(new Date(iso));
export const fmtDayLong = (day: string) => fDayLong.format(new Date(`${day}T12:00:00Z`));
/** "pon. 5.10" */
export const fmtDayShort = (day: string) => {
  const d = new Date(`${day}T12:00:00Z`);
  return `${fWeekday.format(d)} ${d.getUTCDate()}.${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
/** "+48 600 100 206" (polskie numery), inne bez zmian */
export const fmtPhone = (p: string | null) => (p && /^\+48\d{9}$/.test(p) ? `+48 ${p.slice(3, 6)} ${p.slice(6, 9)} ${p.slice(9)}` : p ?? '');
export const fmtDateTime = (iso: string) => fDateTime.format(new Date(iso));
export const fmtDate = (iso: string) => fDate.format(new Date(iso));
export const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
