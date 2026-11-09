import type { CalendarData } from '../types';
import { addDays, dayOf, fmtDayShort, hhmm, minutesOfDay, todayIso } from '../time';
import { axisFor } from './DayGrid';
import { AppointmentCard } from './AppointmentCard';

const ROW = 20;

export function WeekGrid({ monday, data, onOpen, onDay }: {
  monday: string; data: CalendarData; onOpen: (id: string) => void; onDay: (d: string) => void;
}) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const { start, end } = axisFor(days, data);
  const rows = (end - start) / 15;
  const stations = data.stations.filter((s) => s.isActive);
  const y = (m: number) => ((m - start) / 15) * ROW;
  const today = todayIso();

  return (
    <>
    <div className="max-h-[calc(100dvh-8.75rem)] overflow-auto rounded-xl border border-line bg-concrete">
      <div className="grid min-w-[56rem]" style={{ gridTemplateColumns: '3.25rem repeat(7, 1fr)' }}>
        <div className="sticky top-0 z-20 bg-concrete" />
        {days.map((d) => {
          const count = data.appointments.filter((a) => dayOf(a.startsAt) === d && a.status !== 'cancelled').length;
          const closed = !data.openingHours.some((w) => w.day === d);
          return (
            <button key={d} type="button" onClick={() => onDay(d)}
              className={`sticky top-0 z-20 border-b-2 px-2 py-1.5 text-left ${d === today ? 'border-signal bg-paper' : 'border-ink bg-concrete'}`}>
              <span className="block font-display text-[1.1rem] font-bold first-letter:uppercase">{fmtDayShort(d)}</span>
              <span className="block text-[0.8rem] text-muted">{closed ? 'zamknięte' : `${count} ${count === 1 ? 'wizyta' : count >= 2 && count <= 4 ? 'wizyty' : 'wizyt'}`}</span>
            </button>
          );
        })}
        <div className="relative" style={{ height: rows * ROW }}>
          {Array.from({ length: rows / 4 + 1 }, (_, i) => (
            <span key={i} className={`absolute right-2 text-[0.75rem] tabular-nums text-muted ${i === 0 ? 'translate-y-0.5' : '-translate-y-1/2'}`} style={{ top: i * 4 * ROW }}>{hhmm(start + i * 60)}</span>
          ))}
        </div>
        {days.map((d) => {
          const windows = data.openingHours.filter((w) => w.day === d).map((w) => [minutesOfDay(w.opensAt), minutesOfDay(w.closesAt)] as const);
          return (
            <div key={d} className="relative grid border-l border-line" style={{ height: rows * ROW, gridTemplateColumns: `repeat(${stations.length}, 1fr)` }}>
              <div className="absolute inset-0 bg-[repeating-linear-gradient(135deg,#e6e9eb_0_6px,#eef0f1_6px_12px)]" />
              {windows.map(([o, c], i) => <div key={i} className="absolute inset-x-0 bg-paper" style={{ top: y(o), height: y(c) - y(o) }} />)}
              {Array.from({ length: rows / 4 }, (_, i) => <div key={i} className="absolute inset-x-0 border-t border-line" style={{ top: i * 4 * ROW }} />)}
              {stations.map((st) => (
                <div key={st.id} className="relative border-l border-[#e3e6e8] first:border-l-0">
                  {data.blocks.filter((b) => (b.stationId === null || b.stationId === st.id) && dayOf(b.startsAt) === d).map((b) => (
                    <div key={b.id} className="absolute inset-x-0 bg-[repeating-linear-gradient(135deg,rgba(38,42,46,0.18)_0_5px,transparent_5px_10px)]"
                      style={{ top: y(minutesOfDay(b.startsAt)), height: y(minutesOfDay(b.endsAt) || end) - y(minutesOfDay(b.startsAt)) }} />
                  ))}
                  {data.appointments.filter((a) => a.stationId === st.id && dayOf(a.startsAt) === d).map((a) => {
                    const s = minutesOfDay(a.startsAt); const e = minutesOfDay(a.endsAt) || 1440;
                    return <AppointmentCard key={a.id} a={a} dense onOpen={() => onOpen(a.id)} style={{ top: y(s), height: Math.max(y(e) - y(s) - 1, ROW - 1), zIndex: 6 }} />;
                  })}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
    <p className="mt-2 text-[0.85rem] text-muted">W każdym dniu lewa kolumna to {stations[0]?.name ?? 'stanowisko 1'}, prawa {stations[1]?.name ?? 'stanowisko 2'}. Kliknij nagłówek dnia, aby zobaczyć szczegóły.</p>
    </>
  );
}
