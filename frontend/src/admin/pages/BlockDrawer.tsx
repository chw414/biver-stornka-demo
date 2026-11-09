import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { adminApi } from '../api';
import { adminErrorMessage } from '../errors';
import { useCalendar } from '../queries';
import { dayOf, fmtTime, zonedToDate } from '../time';
import type { Station } from '../types';
import { Btn, Drawer, ErrorBox, InfoBox, Input } from '../components/controls';
import { StationSelect, TimeSelect } from '../components/TimeFields';

export function BlockDrawer({ day: initialDay, stations, onClose }: { day: string; stations: Station[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [day, setDay] = useState(initialDay);
  const [from, setFrom] = useState('08:00');
  const [to, setTo] = useState('17:00');
  const [station, setStation] = useState('all');
  const [reason, setReason] = useState('');
  const [conflicts, setConflicts] = useState<{ id: string; referenceCode: string; startsAt: string }[] | null>(null);
  const cal = useCalendar(day, day);
  const existing = cal.data?.blocks.filter((b) => dayOf(b.startsAt) === day) ?? [];

  const create = useMutation({
    mutationFn: () => adminApi<{ id: string; conflicts: { id: string; referenceCode: string; startsAt: string }[] }>('/blocks', {
      method: 'POST',
      json: { stationId: station === 'all' ? null : Number(station), startsAt: zonedToDate(day, from).toISOString(), endsAt: zonedToDate(day, to).toISOString(), reason: reason.trim() || undefined },
    }),
    onSuccess: (r) => { setConflicts(r.conflicts); void qc.invalidateQueries({ queryKey: ['cal'] }); },
  });
  const remove = useMutation({
    mutationFn: (id: string) => adminApi(`/blocks/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['cal'] }),
  });

  return (
    <Drawer title="Blokada stanowiska" onClose={onClose}>
      <div className="space-y-5">
        <p className="text-[0.95rem] text-muted">Zablokowany czas znika z rezerwacji online, np. na czas awarii podnośnika albo nieobecności pracownika.</p>
        {create.isError && <ErrorBox>{adminErrorMessage(create.error)}</ErrorBox>}
        {conflicts && (conflicts.length === 0
          ? <InfoBox>Zablokowano. Żadna wizyta nie koliduje.</InfoBox>
          : <ErrorBox>Zablokowano, ale {conflicts.length === 1 ? 'koliduje 1 wizyta' : `kolidują ${conflicts.length} wizyty`} — przesuń je lub odwołaj:
              <ul className="mt-1 list-disc pl-5">{conflicts.map((c) => <li key={c.id}><a className="underline" href={`#/kalendarz?d=${dayOf(c.startsAt)}&v=day&w=${c.id}`}>{fmtTime(c.startsAt)}, nr {c.referenceCode}</a></li>)}</ul>
            </ErrorBox>)}
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); setConflicts(null); create.mutate(); }}>
          <StationSelect value={station} onChange={setStation} stations={stations.filter((s) => s.isActive)} allowAuto={false} allLabel="Cały serwis" />
          <Input label="Dzień" type="date" value={day} onChange={(e) => setDay(e.target.value)} required />
          <div className="grid grid-cols-2 gap-3"><TimeSelect label="Od" value={from} onChange={setFrom} /><TimeSelect label="Do" value={to} onChange={setTo} /></div>
          <Input label="Powód (opcjonalnie)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="Np. serwis podnośnika" />
          <Btn type="submit" busy={create.isPending} disabled={to <= from}>Zablokuj</Btn>
        </form>
        {existing.length > 0 && (
          <section>
            <h3 className="mb-2 font-semibold">Blokady tego dnia</h3>
            <ul className="divide-y divide-line rounded-xl bg-paper">
              {existing.map((b) => (
                <li key={b.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <span>{fmtTime(b.startsAt)}–{fmtTime(b.endsAt)}, {b.stationId ? stations.find((s) => s.id === b.stationId)?.name : 'cały serwis'}{b.reason ? <span className="text-muted"> ({b.reason})</span> : null}</span>
                  <Btn variant="ghost" busy={remove.isPending && remove.variables === b.id} onClick={() => remove.mutate(b.id)}>Usuń</Btn>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Drawer>
  );
}
