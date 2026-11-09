import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../shared/api';
import { adminApi } from '../api';
import { adminErrorMessage } from '../errors';
import { useAppointment, useCalendar } from '../queries';
import { dayOf, fmtDateTime, fmtDayLong, fmtPhone, fmtTime, minutesOfDay, hhmm, zonedToDate } from '../time';
import type { AppointmentDetail, NotificationInfo } from '../types';
import { Btn, Drawer, ErrorBox, InfoBox, Input, TextArea, Toggle } from '../components/controls';
import { DurationSelect, StationSelect, TimeSelect, durationLabel } from '../components/TimeFields';

const STATUS = { confirmed: 'Potwierdzona', completed: 'Zakończona', no_show: 'Nie przyjechał', cancelled: 'Anulowana' } as const;
const SOURCE = { online: 'rezerwacja online', phone: 'telefonicznie', walk_in: 'na miejscu' } as const;
const KIND = { confirmation: 'Potwierdzenie', reminder_24h: 'Przypomnienie', reschedule: 'Zmiana terminu', cancellation: 'Odwołanie' } as const;
const NSTATUS: Record<NotificationInfo['status'], string> = {
  pending: 'zaplanowane', sent: 'wysłane', delivered: 'dostarczone', read: 'przeczytane', failed: 'nieudane', cancelled: 'nie wysłano',
};
const NOTE_REASON: Record<string, string> = {
  NO_CHANNEL: 'brak zgody na WhatsApp', APPOINTMENT_NOT_ACTIVE: 'wizyta nieaktualna', APPOINTMENT_PASSED: 'po terminie',
  OPT_IN_WITHDRAWN: 'klient wycofał zgodę', '131026': 'numer bez WhatsAppa',
};

export function AppointmentDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useAppointment(id);
  const a = q.data;
  return (
    <Drawer title={a ? `${fmtTime(a.startsAt)}–${fmtTime(a.endsAt)}` : 'Wizyta'} onClose={onClose}>
      {q.isError && <ErrorBox>Nie udało się wczytać wizyty. {q.error.message}</ErrorBox>}
      {!a && q.isPending && <div className="h-64 animate-pulse rounded-xl bg-paper" />}
      {a && <Detail a={a} onClose={onClose} />}
    </Drawer>
  );
}

function Detail({ a, onClose }: { a: AppointmentDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<'view' | 'move' | 'cancel'>('view');
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState(a.adminNotes ?? '');
  useEffect(() => setNotes(a.adminNotes ?? ''), [a.adminNotes]);

  const refresh = () => { void qc.invalidateQueries({ queryKey: ['cal'] }); void qc.invalidateQueries({ queryKey: ['appt', a.id] }); };
  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => adminApi(`/appointments/${a.id}`, { method: 'PATCH', json: { lockVersion: a.lockVersion, ...body } }),
    onSuccess: () => { setError(null); setMode('view'); refresh(); },
    onError: (e) => { setError(adminErrorMessage(e)); if (e instanceof ApiError && e.code === 'STALE_VERSION') refresh(); },
  });

  const started = new Date(a.startsAt) <= new Date();
  const active = a.status === 'confirmed';
  const day = dayOf(a.startsAt);

  return (
    <div className="space-y-5">
      <div>
        <p className="font-semibold first-letter:uppercase">{fmtDayLong(day)}</p>
        <p className="text-muted">{a.stationName}, {a.serviceName}, {durationLabel((+new Date(a.endsAt) - +new Date(a.startsAt)) / 60000)}</p>
        <p className="mt-1 flex flex-wrap gap-x-3 text-[0.92rem]">
          <span className={`font-semibold ${a.status === 'no_show' || a.status === 'cancelled' ? 'text-danger' : a.status === 'completed' ? 'text-ok' : ''}`}>{STATUS[a.status]}</span>
          <span className="text-muted">nr {a.referenceCode}, {SOURCE[a.source]}</span>
        </p>
        {a.status === 'cancelled' && a.cancellationReason && <p className="mt-1 text-[0.92rem] text-muted">Powód: {a.cancellationReason}</p>}
      </div>

      {error && <ErrorBox>{error}</ErrorBox>}

      <section className="rounded-xl bg-paper px-4 py-3">
        <h3 className="sr-only">Klient i samochód</h3>
        <p className="font-display text-[1.6rem] font-bold tracking-wide">{a.vehicle.registrationNumber ?? '—'}</p>
        <p className="text-muted">{a.vehicle.make} {a.vehicle.model}{a.vehicle.tireSize ? `, opony ${a.vehicle.tireSize}` : ''}</p>
        <div className="mt-3 border-t border-line pt-3">
          {a.customer.fullName
            ? <a href={`#/klienci/${a.customer.id}`} className="font-semibold underline decoration-signal decoration-[3px] underline-offset-4">{a.customer.fullName}</a>
            : <span className="text-muted">Dane zanonimizowane</span>}
          {a.customer.phone && <p><a href={`tel:${a.customer.phone}`} className="tabular-nums">{fmtPhone(a.customer.phone)}</a>{a.customer.whatsappOptIn && <span className="ml-2 text-[0.85rem] text-ok">zgoda WhatsApp</span>}</p>}
          {a.bookedFullName && a.bookedFullName !== a.customer.fullName && (
            <p className="mt-1 text-[0.9rem] text-muted">W formularzu wpisano: „{a.bookedFullName}”</p>
          )}
        </div>
        {a.customerNotes && <p className="mt-3 border-t border-line pt-3 text-[0.95rem]"><span className="text-muted">Uwagi klienta: </span>{a.customerNotes}</p>}
      </section>

      {mode === 'view' && active && (
        <div className="grid grid-cols-2 gap-2">
          <Btn variant="secondary" onClick={() => { setError(null); setMode('move'); }}>Przesuń</Btn>
          <Btn variant="secondary" className="text-danger" onClick={() => { setError(null); setMode('cancel'); }}>Odwołaj</Btn>
          <Btn variant="secondary" disabled={!started} busy={patch.isPending && patch.variables?.status === 'completed'} onClick={() => patch.mutate({ status: 'completed' })}>Zakończona</Btn>
          <Btn variant="secondary" disabled={!started} busy={patch.isPending && patch.variables?.status === 'no_show'} onClick={() => patch.mutate({ status: 'no_show' })}>Nie przyjechał</Btn>
          {!started && <p className="col-span-2 text-[0.88rem] text-muted">Status „zakończona” i „nie przyjechał” ustawisz po rozpoczęciu wizyty.</p>}
        </div>
      )}
      {mode === 'view' && (a.status === 'completed' || a.status === 'no_show') && (
        <Btn variant="secondary" busy={patch.isPending} onClick={() => patch.mutate({ status: 'confirmed' })}>Cofnij status</Btn>
      )}
      {mode === 'move' && <MoveForm a={a} busy={patch.isPending} onCancel={() => setMode('view')} onSubmit={(b) => patch.mutate(b)} />}
      {mode === 'cancel' && <CancelForm a={a} onDone={() => { refresh(); onClose(); }} onBack={() => setMode('view')} />}

      <section>
        <TextArea label="Notatka warsztatu" hint="Widoczna tylko w panelu." value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} />
        {notes !== (a.adminNotes ?? '') && (
          <Btn className="mt-2" busy={patch.isPending} onClick={() => patch.mutate({ adminNotes: notes.trim() || null })}>Zapisz notatkę</Btn>
        )}
      </section>

      <section>
        <h3 className="mb-2 font-semibold">Wiadomości do klienta</h3>
        {a.notifications.length === 0 && <p className="text-[0.95rem] text-muted">Brak — klient nie dostaje powiadomień o tej wizycie.</p>}
        <ul className="divide-y divide-line rounded-xl bg-paper">
          {a.notifications.map((n, i) => (
            <li key={i} className="flex items-baseline justify-between gap-3 px-4 py-2.5 text-[0.95rem]">
              <span>{KIND[n.kind]}{n.channel && <span className="text-muted"> ({n.channel === 'whatsapp' ? 'WhatsApp' : 'SMS'})</span>}</span>
              <span className={`text-right ${n.status === 'failed' ? 'font-semibold text-danger' : n.status === 'cancelled' ? 'text-muted' : ''}`}>
                {NSTATUS[n.status]}
                {n.status === 'pending' && `, ${fmtDateTime(n.scheduledFor)}`}
                {n.errorCode && (n.status === 'failed' || n.status === 'cancelled') && <span className="block text-[0.82rem] font-normal text-muted">{NOTE_REASON[n.errorCode] ?? `kod ${n.errorCode}`}</span>}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function MoveForm({ a, busy, onCancel, onSubmit }: { a: AppointmentDetail; busy: boolean; onCancel: () => void; onSubmit: (b: Record<string, unknown>) => void }) {
  const [day, setDay] = useState(dayOf(a.startsAt));
  const [time, setTime] = useState(hhmm(minutesOfDay(a.startsAt)));
  const [station, setStation] = useState(String(a.stationId));
  const [duration, setDuration] = useState((+new Date(a.endsAt) - +new Date(a.startsAt)) / 60000);
  const [notify, setNotify] = useState(a.customer.phone !== null);
  const [outside, setOutside] = useState(false);
  const cal = useCalendar(day, day);
  const closedDay = cal.data && !cal.data.openingHours.some((w) => w.day === day);

  return (
    <form className="space-y-3 rounded-xl border-2 border-ink bg-paper p-4" onSubmit={(e) => {
      e.preventDefault();
      onSubmit({ startsAt: zonedToDate(day, time).toISOString(), durationMinutes: duration, notifyCustomer: notify, allowOutsideHours: outside,
        ...(station ? { stationId: Number(station) } : {}) });
    }}>
      <h3 className="font-display text-[1.3rem] font-bold">Nowy termin</h3>
      <div className="grid grid-cols-2 gap-3">
        <Input label="Dzień" type="date" value={day} onChange={(e) => setDay(e.target.value)} required />
        <TimeSelect value={time} onChange={setTime} />
        <StationSelect value={station} onChange={setStation} stations={cal.data?.stations ?? [{ id: a.stationId, name: a.stationName }]} />
        <DurationSelect value={duration} onChange={setDuration} />
      </div>
      {closedDay && <InfoBox>Serwis jest tego dnia zamknięty.</InfoBox>}
      <Toggle checked={outside} onChange={setOutside}>Zapisz także poza godzinami pracy</Toggle>
      {a.customer.phone && <Toggle checked={notify} onChange={setNotify}>Powiadom klienta o zmianie terminu</Toggle>}
      <div className="flex gap-2"><Btn type="submit" busy={busy}>Przesuń wizytę</Btn><Btn type="button" variant="ghost" onClick={onCancel}>Anuluj</Btn></div>
    </form>
  );
}

function CancelForm({ a, onDone, onBack }: { a: AppointmentDetail; onDone: () => void; onBack: () => void }) {
  const [reason, setReason] = useState('');
  const [notify, setNotify] = useState(a.customer.phone !== null && new Date(a.startsAt) > new Date());
  const m = useMutation({
    mutationFn: () => adminApi(`/appointments/${a.id}/cancel`, { method: 'POST', json: { lockVersion: a.lockVersion, reason: reason.trim() || undefined, notifyCustomer: notify } }),
    onSuccess: onDone,
  });
  return (
    <div className="space-y-3 rounded-xl border-2 border-danger bg-paper p-4">
      <h3 className="font-display text-[1.3rem] font-bold">Odwołać wizytę?</h3>
      {m.isError && <ErrorBox>{adminErrorMessage(m.error)}</ErrorBox>}
      <Input label="Powód (opcjonalnie)" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="Np. klient zadzwonił" />
      {a.customer.phone && <Toggle checked={notify} onChange={setNotify}>Wyślij klientowi wiadomość o odwołaniu</Toggle>}
      <div className="flex gap-2">
        <Btn variant="danger" busy={m.isPending} onClick={() => m.mutate()}>Odwołaj wizytę</Btn>
        <Btn variant="ghost" onClick={onBack}>Nie odwołuj</Btn>
      </div>
    </div>
  );
}
