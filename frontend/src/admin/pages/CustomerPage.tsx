import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adminApi } from '../api';
import { adminErrorMessage } from '../errors';
import { dayOf, fmtDate, fmtDateTime, fmtPhone } from '../time';
import type { Admin, CustomerCard, Vehicle } from '../types';
import { Btn, ErrorBox, InfoBox, Input, TextArea } from '../components/controls';

const STATUS = { confirmed: 'potwierdzona', completed: 'zakończona', no_show: 'nie przyjechał', cancelled: 'anulowana' } as const;

export function CustomerPage({ id, admin }: { id: string; admin: Admin }) {
  const qc = useQueryClient();
  const card = useQuery({ queryKey: ['customer', id], queryFn: () => adminApi<{ customer: CustomerCard }>(`/customers/${id}`).then((r) => r.customer) });
  const c = card.data;
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['customer', id] }); void qc.invalidateQueries({ queryKey: ['customers-list'] }); };

  if (card.isError) return <div className="mx-auto max-w-3xl p-5"><ErrorBox>{card.error.message}</ErrorBox></div>;
  if (!c) return <div className="mx-auto max-w-3xl p-5"><div className="h-64 animate-pulse rounded-xl bg-paper" /></div>;

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-3 py-5 sm:px-5">
      <a href="#/klienci" className="text-[0.95rem] text-muted underline">Wszyscy klienci</a>
      <h1 className="font-display text-[2rem] font-bold leading-tight">{c.fullName ?? 'Dane zanonimizowane'}</h1>
      {c.anonymizedAt && <InfoBox>Dane osobowe usunięto {fmtDate(c.anonymizedAt)}. Historia wizyt została zachowana bez danych identyfikujących.</InfoBox>}
      {!c.anonymizedAt && <ContactForm c={c} onSaved={refresh} />}

      <section>
        <h2 className="mb-2 font-display text-[1.4rem] font-bold">Samochody</h2>
        <ul className="space-y-3">{c.vehicles.map((v) => <VehicleRow key={v.id} v={v} readOnly={!!c.anonymizedAt} onSaved={refresh} />)}</ul>
      </section>

      <section>
        <h2 className="mb-2 font-display text-[1.4rem] font-bold">Historia wizyt</h2>
        {c.appointments.length === 0 && <p className="text-muted">Brak wizyt.</p>}
        <ul className="divide-y divide-line overflow-hidden rounded-xl bg-paper">
          {c.appointments.map((a) => {
            const v = c.vehicles.find((x) => x.id === a.vehicleId);
            return (
              <li key={a.id}>
                <a href={`#/kalendarz?d=${dayOf(a.startsAt)}&v=day&w=${a.id}`} className="flex flex-wrap items-baseline justify-between gap-x-4 px-4 py-2.5 hover:bg-[#fff6d6]">
                  <span><span className="font-semibold tabular-nums">{fmtDateTime(a.startsAt)}</span> <span className="text-muted">{a.serviceName}</span></span>
                  <span className="text-[0.92rem]">{v?.registrationNumber ?? ''} <span className={a.status === 'no_show' ? 'text-danger' : 'text-muted'}>{STATUS[a.status]}</span></span>
                </a>
              </li>
            );
          })}
        </ul>
      </section>

      {c.consents.length > 0 && (
        <section>
          <h2 className="mb-2 font-display text-[1.4rem] font-bold">Zgody</h2>
          <ul className="space-y-1 text-[0.95rem]">
            {c.consents.map((x, i) => (
              <li key={i}>{x.kind === 'terms' ? 'Regulamin' : x.kind === 'privacy' ? 'Informacja o danych' : x.kind === 'whatsapp' ? 'WhatsApp' : x.kind} (wersja {x.version}): {fmtDate(x.grantedAt)}{x.withdrawnAt && <span className="text-danger">, wycofana {fmtDate(x.withdrawnAt)}</span>}</li>
            ))}
          </ul>
        </section>
      )}

      {admin.role === 'owner' && !c.anonymizedAt && <Anonymize c={c} onDone={refresh} />}
    </div>
  );
}

function ContactForm({ c, onSaved }: { c: CustomerCard; onSaved: () => void }) {
  const [fullName, setFullName] = useState(c.fullName ?? '');
  const [phone, setPhone] = useState(fmtPhone(c.phone));
  const [notes, setNotes] = useState(c.adminNotes ?? '');
  useEffect(() => { setFullName(c.fullName ?? ''); setPhone(fmtPhone(c.phone)); setNotes(c.adminNotes ?? ''); }, [c]);
  const digits = (x: string | null) => (x ?? '').replace(/\D/g, '').replace(/^48(?=\d{9}$)/, '');
  const phoneChanged = digits(phone) !== digits(c.phone);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => adminApi(`/customers/${c.id}`, { method: 'PATCH', json: body }),
    onSuccess: onSaved,
  });
  const dirty = fullName !== (c.fullName ?? '') || phoneChanged || notes !== (c.adminNotes ?? '');
  return (
    <section className="space-y-3 rounded-xl bg-paper p-4">
      {save.isError && <ErrorBox>{adminErrorMessage(save.error)}</ErrorBox>}
      {save.isSuccess && !dirty && <p role="status" className="text-[0.92rem] text-ok">Zapisano.</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Input label="Imię i nazwisko" value={fullName} onChange={(e) => setFullName(e.target.value)} />
        <Input label="Telefon" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
      </div>
      <TextArea label="Notatka o kliencie" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
      <div className="flex flex-wrap items-center gap-3">
        <Btn disabled={!dirty} busy={save.isPending && !('whatsappOptIn' in (save.variables ?? {}))}
          onClick={() => save.mutate({ ...(fullName !== c.fullName ? { fullName } : {}), ...(phoneChanged ? { phone } : {}), adminNotes: notes.trim() || null })}>
          Zapisz zmiany
        </Btn>
        <span className="text-[0.95rem]">
          WhatsApp: {c.whatsappOptIn ? <span className="font-semibold text-ok">zgoda</span> : <span className="text-muted">brak zgody</span>}{' '}
          <Btn variant="ghost" busy={save.isPending && 'whatsappOptIn' in (save.variables ?? {})}
            onClick={() => save.mutate({ whatsappOptIn: !c.whatsappOptIn })}>
            {c.whatsappOptIn ? 'Wycofaj zgodę' : 'Zapisz zgodę klienta'}
          </Btn>
        </span>
      </div>
    </section>
  );
}

function VehicleRow({ v, readOnly, onSaved }: { v: Vehicle; readOnly: boolean; onSaved: () => void }) {
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState({ registrationNumber: v.registrationNumber ?? '', make: v.make, model: v.model, tireSize: v.tireSize ?? '', notes: v.notes ?? '' });
  const save = useMutation({
    mutationFn: () => adminApi(`/vehicles/${v.id}`, { method: 'PATCH', json: {
      registrationNumber: f.registrationNumber.toUpperCase().replace(/[\s-]/g, ''), make: f.make, model: f.model,
      tireSize: f.tireSize.trim() || null, notes: f.notes.trim() || null } }),
    onSuccess: () => { setEdit(false); onSaved(); },
  });
  if (!edit) {
    return (
      <li className="flex items-start justify-between gap-3 rounded-xl bg-paper px-4 py-3">
        <div>
          <p className="font-display text-[1.35rem] font-bold tracking-wide">{v.registrationNumber ?? '—'}</p>
          <p className="text-muted">{v.make} {v.model}{v.tireSize && <>, opony <span className="font-semibold text-ink">{v.tireSize}</span></>}</p>
          {v.notes && <p className="mt-1 text-[0.92rem]">{v.notes}</p>}
        </div>
        {!readOnly && <Btn variant="ghost" onClick={() => setEdit(true)}>Edytuj</Btn>}
      </li>
    );
  }
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <li className="space-y-3 rounded-xl border-2 border-ink bg-paper p-4">
      {save.isError && <ErrorBox>{adminErrorMessage(save.error)}</ErrorBox>}
      <div className="grid grid-cols-2 gap-3">
        <Input label="Numer rejestracyjny" value={f.registrationNumber} onChange={set('registrationNumber')} />
        <Input label="Rozmiar opon" value={f.tireSize} onChange={set('tireSize')} placeholder="205/55 R16" />
        <Input label="Marka" value={f.make} onChange={set('make')} />
        <Input label="Model" value={f.model} onChange={set('model')} />
      </div>
      <TextArea label="Notatka o samochodzie" value={f.notes} onChange={set('notes')} placeholder="Np. opony zimowe w przechowalni, regał B3" />
      <div className="flex gap-2"><Btn busy={save.isPending} onClick={() => save.mutate()}>Zapisz</Btn><Btn variant="ghost" onClick={() => setEdit(false)}>Anuluj</Btn></div>
    </li>
  );
}

function Anonymize({ c, onDone }: { c: CustomerCard; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const m = useMutation({ mutationFn: () => adminApi(`/customers/${c.id}/anonymize`, { method: 'POST' }), onSuccess: onDone });
  const upcoming = c.appointments.filter((a) => a.status === 'confirmed' && new Date(a.startsAt) > new Date()).length;
  return (
    <section className="rounded-xl border-2 border-line p-4">
      <h2 className="font-display text-[1.3rem] font-bold">Usunięcie danych (RODO)</h2>
      <p className="mt-1 text-[0.95rem] text-muted">Na prośbę klienta: usuwa imię, telefon, numery rejestracyjne i notatki. Statystyki wizyt zostają. Tej operacji nie można cofnąć.</p>
      {!open && <Btn variant="secondary" className="mt-3 text-danger" onClick={() => setOpen(true)}>Usuń dane klienta…</Btn>}
      {open && (
        <div className="mt-3 space-y-3">
          {upcoming > 0 && <ErrorBox>Klient ma {upcoming} nadchodzące wizyty. Najpierw je odwołaj.</ErrorBox>}
          {m.isError && <ErrorBox>{adminErrorMessage(m.error)}</ErrorBox>}
          <Input label="Aby potwierdzić, wpisz numer telefonu klienta" value={confirm} onChange={(e) => setConfirm(e.target.value)} inputMode="tel" />
          <div className="flex gap-2">
            <Btn variant="danger" busy={m.isPending} disabled={upcoming > 0 || confirm.replace(/\D/g, '').slice(-9) !== (c.phone ?? '').replace(/\D/g, '').slice(-9)}
              onClick={() => m.mutate()}>Usuń dane na stałe</Btn>
            <Btn variant="ghost" onClick={() => { setOpen(false); setConfirm(''); }}>Anuluj</Btn>
          </div>
        </div>
      )}
    </section>
  );
}
