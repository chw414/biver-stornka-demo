import { useState } from 'react';
import type { Route } from '../router';
import { navigate } from '../router';
import { addDays, fmtDayLong, fmtDayShort, todayIso, weekStart } from '../time';
import { useCalendar } from '../queries';
import { DayGrid, type SlotClick } from '../components/DayGrid';
import { WeekGrid } from '../components/WeekGrid';
import { Btn, ErrorBox } from '../components/controls';
import { AppointmentDrawer } from './AppointmentDrawer';
import { NewAppointmentDrawer } from './NewAppointmentDrawer';
import { BlockDrawer } from './BlockDrawer';

export function CalendarPage({ route }: { route: Route }) {
  const day = route.params.get('d') ?? todayIso();
  const view = route.params.get('v') === 'week' ? 'week' : 'day';
  const openId = route.params.get('w');
  const monday = weekStart(day);
  const [from, to] = view === 'day' ? [day, day] : [monday, addDays(monday, 6)];
  const cal = useCalendar(from, to);
  const [newAt, setNewAt] = useState<SlotClick | { day: string } | null>(null);
  const [blockOpen, setBlockOpen] = useState(false);

  const go = (params: Record<string, string | null>) => {
    const p: Record<string, string> = { d: day, v: view };
    for (const [k, v] of Object.entries({ ...p, ...params })) if (v !== null) p[k] = v; else delete p[k];
    navigate('/kalendarz', p);
  };
  const step = view === 'day' ? 1 : 7;
  const title = view === 'day' ? fmtDayLong(day) : `${fmtDayShort(monday)} – ${fmtDayShort(addDays(monday, 6))}`;
  const shortTitle = view === 'day' ? fmtDayShort(day) : title;
  const activeCount = cal.data?.appointments.filter((a) => a.status !== 'cancelled').length ?? 0;

  return (
    <div className="mx-auto max-w-[90rem] px-3 pb-10 sm:px-5">
      <div className="sticky top-[3.25rem] z-20 -mx-3 flex flex-wrap items-center gap-2 bg-concrete px-3 py-3 sm:-mx-5 sm:px-5">
        <div className="flex items-center gap-1">
          <Btn variant="secondary" className="px-3" onClick={() => go({ d: addDays(day, -step) })} aria-label={view === 'day' ? 'Poprzedni dzień' : 'Poprzedni tydzień'}>‹</Btn>
          <Btn variant="secondary" onClick={() => go({ d: todayIso() })}>Dziś</Btn>
          <Btn variant="secondary" className="px-3" onClick={() => go({ d: addDays(day, step) })} aria-label={view === 'day' ? 'Następny dzień' : 'Następny tydzień'}>›</Btn>
        </div>
        <h1 className="min-w-0 flex-1 truncate font-display text-[1.6rem] font-bold leading-tight first-letter:uppercase sm:text-[1.9rem]">
          <span className="sm:hidden">{shortTitle}</span><span className="hidden sm:inline">{title}</span>
          <span className="ml-2 align-middle font-sans text-[0.95rem] font-normal text-muted">{cal.data ? `${activeCount} wiz.` : ''}</span>
        </h1>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border-2 border-line bg-paper p-0.5" role="group" aria-label="Widok">
            {(['day', 'week'] as const).map((v) => (
              <button key={v} type="button" aria-pressed={view === v} onClick={() => go({ v })}
                className={`rounded-md px-3 py-1.5 text-[0.95rem] font-semibold ${view === v ? 'bg-ink text-white' : 'text-muted'}`}>
                {v === 'day' ? 'Dzień' : 'Tydzień'}
              </button>
            ))}
          </div>
          <input type="date" value={day} onChange={(e) => e.target.value && go({ d: e.target.value })} aria-label="Przejdź do daty"
            className="hidden min-h-[2.75rem] rounded-lg border-2 border-line bg-paper px-2 md:block" />
          <Btn variant="secondary" onClick={() => setBlockOpen(true)} className="whitespace-nowrap">Zablokuj</Btn>
          <Btn onClick={() => setNewAt({ day })} className="whitespace-nowrap">Nowa wizyta</Btn>
        </div>
      </div>

      {cal.isError && <div className="mb-3"><ErrorBox>Nie udało się wczytać kalendarza. {cal.error.message}</ErrorBox></div>}
      {!cal.data && cal.isPending && <div className="h-[60vh] animate-pulse rounded-xl bg-paper" aria-busy="true" />}
      {cal.data && view === 'day' && (
        <>
          {!cal.data.openingHours.some((w) => w.day === day) && (
            <p className="mb-2 text-[0.95rem] text-muted">Serwis jest tego dnia zamknięty. Wizytę możesz dodać mimo to — formularz poprosi o potwierdzenie.</p>
          )}
          <DayGrid day={day} data={cal.data} onOpen={(id) => go({ w: id })} onSlot={(s) => setNewAt(s)} />
        </>
      )}
      {cal.data && view === 'week' && <WeekGrid monday={monday} data={cal.data} onOpen={(id) => go({ w: id })} onDay={(d) => go({ d, v: 'day' })} />}

      {openId && <AppointmentDrawer id={openId} onClose={() => go({ w: null })} />}
      {newAt && <NewAppointmentDrawer prefill={newAt} onClose={() => setNewAt(null)} onCreated={(id, d) => { setNewAt(null); go({ d, w: id, v: 'day' }); }} />}
      {blockOpen && <BlockDrawer day={day} stations={cal.data?.stations ?? []} onClose={() => setBlockOpen(false)} />}
    </div>
  );
}
