import { useEffect, useState } from 'react';
import type { CalendarData } from '../types';
import { dayOf, hhmm, minutesOfDay, todayIso } from '../time';
import { AppointmentCard } from './AppointmentCard';

const ROW = 30; // px na 15 minut

export interface SlotClick { day: string; minute: number; stationId: number }

/** Zakres osi czasu dnia: godziny otwarcia ∪ wizyty/blokady poza nimi; zamknięte → 8–17. */
export function axisFor(days: string[], data: CalendarData) {
  const mins: number[] = [];
  for (const w of data.openingHours.filter((o) => days.includes(o.day))) mins.push(minutesOfDay(w.opensAt), minutesOfDay(w.closesAt));
  for (const a of data.appointments.filter((x) => days.includes(dayOf(x.startsAt)))) mins.push(minutesOfDay(a.startsAt), minutesOfDay(a.endsAt) || 1440);
  const start = mins.length ? Math.floor(Math.min(...mins) / 60) * 60 : 8 * 60;
  const end = mins.length ? Math.ceil(Math.max(...mins) / 60) * 60 : 17 * 60;
  return { start: Math.min(start, 8 * 60), end: Math.max(end, start + 60) };
}

function useNowMinute() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 60_000); return () => clearInterval(t); }, []);
  return now;
}

export function DayGrid({ day, data, onOpen, onSlot }: {
  day: string; data: CalendarData; onOpen: (id: string) => void; onSlot: (s: SlotClick) => void;
}) {
  const { start, end } = axisFor([day], data);
  const rows = (end - start) / 15;
  const windows = data.openingHours.filter((w) => w.day === day).map((w) => [minutesOfDay(w.opensAt), minutesOfDay(w.closesAt)] as const);
  const isOpen = (m: number) => windows.some(([o, c]) => m >= o && m < c);
  const stations = data.stations.filter((s) => s.isActive);
  const appts = data.appointments.filter((a) => dayOf(a.startsAt) === day);
  const blocks = data.blocks.filter((b) => dayOf(b.startsAt) <= day && dayOf(new Date(new Date(b.endsAt).getTime() - 1)) >= day);
  const now = useNowMinute();
  const nowMin = day === todayIso() ? minutesOfDay(now) : null;
  const y = (m: number) => ((m - start) / 15) * ROW;

  const blockRange = (b: { startsAt: string; endsAt: string }) => {
    const s = dayOf(b.startsAt) < day ? start : minutesOfDay(b.startsAt);
    const e = dayOf(new Date(new Date(b.endsAt).getTime() - 1)) > day ? end : minutesOfDay(b.endsAt) || end;
    return [Math.max(s, start), Math.min(e, end)] as const;
  };

  return (
    <div className="max-h-[calc(100dvh-8.75rem)] overflow-auto rounded-xl border border-line bg-concrete">
      <div className="grid min-w-[22rem]" style={{ gridTemplateColumns: `3.25rem repeat(${stations.length}, minmax(9rem, 1fr))` }}>
        {/* nagłówki stanowisk */}
        <div className="sticky top-0 z-20 bg-concrete" />
        {stations.map((s) => (
          <div key={s.id} className="sticky top-0 z-20 border-b-2 border-ink bg-concrete px-2 py-2 font-display text-[1.15rem] font-bold">{s.name}</div>
        ))}

        {/* oś godzin */}
        <div className="relative" style={{ height: rows * ROW }}>
          {Array.from({ length: rows / 4 + 1 }, (_, i) => (
            <span key={i} className={`absolute right-2 text-[0.8rem] tabular-nums text-muted ${i === 0 ? 'translate-y-0.5' : '-translate-y-1/2'}`} style={{ top: i * 4 * ROW }}>
              {hhmm(start + i * 60)}
            </span>
          ))}
        </div>

        {stations.map((st) => (
          <div key={st.id} className="relative border-l border-line" style={{ height: rows * ROW }}>
            {/* kratki 15-min: wolne w godzinach otwarcia → klik dodaje wizytę */}
            {Array.from({ length: rows }, (_, i) => {
              const m = start + i * 15;
              const open = isOpen(m);
              return (
                <button
                  key={i}
                  type="button"
                  tabIndex={-1}
                  onClick={() => onSlot({ day, minute: m, stationId: st.id })}
                  aria-label={`Dodaj wizytę: ${st.name}, ${hhmm(m)}`}
                  className={`absolute inset-x-0 border-t ${i % 4 === 0 ? 'border-line' : 'border-[#e3e6e8]'} ${open ? 'bg-paper hover:bg-[#fff6d6]' : 'bg-[repeating-linear-gradient(135deg,#e6e9eb_0_6px,#eef0f1_6px_12px)]'}`}
                  style={{ top: i * ROW, height: ROW }}
                />
              );
            })}
            {blocks.filter((b) => b.stationId === null || b.stationId === st.id).map((b) => {
              const [s, e] = blockRange(b);
              return (
                <div key={b.id} className="pointer-events-none absolute inset-x-0 z-[5] flex items-start bg-[repeating-linear-gradient(135deg,rgba(38,42,46,0.16)_0_7px,rgba(38,42,46,0.04)_7px_14px)] px-2 pt-1 text-[0.82rem] font-semibold text-asphalt"
                  style={{ top: y(s), height: y(e) - y(s) }}>
                  Zablokowane{b.reason ? `: ${b.reason}` : ''}
                </div>
              );
            })}
            {appts.filter((a) => a.stationId === st.id).map((a) => {
              const s = minutesOfDay(a.startsAt);
              const e = minutesOfDay(a.endsAt) || 1440;
              return <AppointmentCard key={a.id} a={a} compact={e - s <= 15} onOpen={() => onOpen(a.id)} style={{ top: y(s) + 1, height: y(e) - y(s) - 2, zIndex: 6 }} />;
            })}
            {nowMin !== null && nowMin >= start && nowMin <= end && (
              <div className="pointer-events-none absolute inset-x-0 z-10 h-0.5 bg-danger" style={{ top: y(nowMin) }} aria-hidden="true" />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
