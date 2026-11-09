import { useEffect, useMemo, useRef } from 'react';
import { labelFromIso, makeFormatters, nextDays } from '../format';
import { useAvailableDays, useSlots } from '../queries';
import type { Service, Slot } from '../types';
import { Alert } from '../../shared/ui';

export function DateTimeStep({ service, timezone, horizonDays, date, slot, notice, onDate, onSlot }: {
  service: Service; timezone: string; horizonDays: number;
  date: string | null; slot: Slot | null; notice: string | null;
  onDate: (d: string) => void; onSlot: (s: Slot) => void;
}) {
  const fmt = useMemo(() => makeFormatters(timezone), [timezone]);
  const today = fmt.isoDay(new Date());
  const days = useMemo(() => nextDays(today, Math.min(horizonDays + 1, 62)), [today, horizonDays]);
  const available = useAvailableDays(service.id, days[0]!, days.at(-1)!);
  const slots = useSlots(service.id, date);

  // automatycznie wybierz pierwszy dzień z wolnymi terminami
  useEffect(() => {
    if (!date && available.data) {
      const first = days.find((d) => available.data.has(d));
      if (first) onDate(first);
    }
  }, [available.data, date, days, onDate]);

  const selectedDayRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { selectedDayRef.current?.scrollIntoView({ block: 'nearest', inline: 'center' }); }, [date]);

  const groups = useMemo(() => {
    const list = slots.data ?? [];
    return [
      { label: 'Przed południem', items: list.filter((s) => fmt.hour(s.startsAt) < 12) },
      { label: 'Po południu', items: list.filter((s) => fmt.hour(s.startsAt) >= 12) },
    ].filter((g) => g.items.length > 0);
  }, [slots.data, fmt]);

  const noDaysAtAll = available.data && !days.some((d) => available.data.has(d));

  return (
    <div className="space-y-6">
      {notice && <Alert>{notice}</Alert>}

      <section aria-labelledby="day-heading">
        <h2 id="day-heading" className="mb-2.5 font-semibold">Dzień</h2>
        {available.isError && <Alert>Nie udało się sprawdzić wolnych dni. {available.error.message}</Alert>}
        {noDaysAtAll && <Alert tone="info">Brak wolnych terminów online na najbliższe tygodnie. Zadzwoń — postaramy się Cię zmieścić.</Alert>}
        <div className="-mx-4 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
          <ul className="flex gap-2" role="list">
            {days.map((d) => {
              const label = labelFromIso(d);
              const free = available.data?.has(d) ?? false;
              const selected = d === date;
              return (
                <li key={d}>
                  <button
                    ref={selected ? selectedDayRef : undefined}
                    type="button"
                    disabled={!free}
                    onClick={() => onDate(d)}
                    aria-pressed={selected}
                    aria-label={`${fmt.dayLong(label)}${free ? '' : ', brak wolnych terminów'}`}
                    className={[
                      'flex h-[4.6rem] w-[3.9rem] flex-col items-center justify-center rounded-lg border-2 leading-tight',
                      selected ? 'border-ink bg-signal text-ink'
                        : free ? 'border-line bg-paper text-ink'
                          : 'border-transparent bg-transparent text-[#a3a9ae]',
                    ].join(' ')}
                  >
                    <span className="text-[0.85rem]">{fmt.weekdayShort(label)}</span>
                    <span className="font-display text-[1.6rem] font-bold">{label.getUTCDate()}</span>
                    <span className="text-[0.8rem]">{fmt.monthShort(label)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      {date && (
        <section aria-labelledby="time-heading" aria-busy={slots.isFetching}>
          <h2 id="time-heading" className="mb-2.5 font-semibold">
            Godzina <span className="font-normal text-muted">({fmt.dayLong(labelFromIso(date))})</span>
          </h2>
          {slots.isPending && <div className="grid grid-cols-4 gap-2">{Array.from({ length: 8 }, (_, i) => <span key={i} className="h-12 animate-pulse rounded-lg bg-paper" />)}</div>}
          {slots.isError && <Alert>Nie udało się wczytać godzin. {slots.error.message}</Alert>}
          {slots.data?.length === 0 && <Alert tone="info">Ten dzień właśnie się zapełnił. Wybierz inny dzień.</Alert>}
          <div className="space-y-4">
            {groups.map((g) => (
              <div key={g.label}>
                <h3 className="mb-2 text-[0.92rem] text-muted">{g.label}</h3>
                <ul className="grid grid-cols-4 gap-2 sm:grid-cols-5" role="list">
                  {g.items.map((s) => {
                    const selected = slot?.startsAt === s.startsAt;
                    return (
                      <li key={s.startsAt}>
                        <button
                          type="button"
                          onClick={() => onSlot(s)}
                          aria-pressed={selected}
                          data-starts-at={s.startsAt}
                          className={[
                            'h-12 w-full rounded-lg border-2 font-display text-[1.25rem] font-semibold tabular-nums',
                            selected ? 'border-ink bg-signal' : 'border-line bg-paper active:bg-concrete',
                          ].join(' ')}
                        >
                          {fmt.time(s.startsAt)}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
