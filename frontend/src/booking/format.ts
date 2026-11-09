/** Wszystkie daty pokazujemy w strefie serwisu — niezależnie od strefy telefonu klienta. */
export function makeFormatters(timeZone: string) {
  const weekday = new Intl.DateTimeFormat('pl-PL', { timeZone, weekday: 'short' });
  const month = new Intl.DateTimeFormat('pl-PL', { timeZone, month: 'short' });
  const long = new Intl.DateTimeFormat('pl-PL', { timeZone, weekday: 'long', day: 'numeric', month: 'long' });
  const time = new Intl.DateTimeFormat('pl-PL', { timeZone, hour: '2-digit', minute: '2-digit' });
  const isoDay = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const hour = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hour12: false });
  return {
    /** "pon." */
    weekdayShort: (d: Date) => weekday.format(d),
    /** "śr. 7 paź" */
    dayShort: (d: Date) => `${weekday.format(d)} ${d.getUTCDate()} ${month.format(d).replace('.', '')}`,
    /** "paź" */
    monthShort: (d: Date) => month.format(d).replace('.', ''),
    /** "poniedziałek, 12 października" */
    dayLong: (d: Date) => long.format(d),
    /** "09:30" */
    time: (d: Date | string) => time.format(new Date(d)),
    /** "2026-10-12" w strefie serwisu */
    isoDay: (d: Date) => isoDay.format(d),
    hour: (d: Date | string) => Number(hour.format(new Date(d))),
  };
}

/** Kolejne dni kalendarzowe od dziś (w strefie serwisu), jako daty o północy UTC — tylko do etykiet. */
export function nextDays(todayIso: string, count: number): string[] {
  const start = new Date(`${todayIso}T12:00:00Z`);
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
}

/** Etykiety dnia z daty ISO (bez przesunięć strefy — data jest już "lokalna" dla serwisu). */
export const labelFromIso = (iso: string) => new Date(`${iso}T12:00:00Z`);

export function formatDuration(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export const formatPrice = (pln: number) =>
  new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN', maximumFractionDigits: pln % 1 ? 2 : 0 }).format(pln);
