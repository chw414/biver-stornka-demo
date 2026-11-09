import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../shared/api';
import { adminApi } from '../api';
import { adminErrorMessage } from '../errors';
import { useAdminServices, useCalendar } from '../queries';
import { fmtPhone, hhmm, zonedToDate } from '../time';
import type { AdminService, AppointmentDetail, CustomerCard, CustomerRow } from '../types';
import type { SlotClick } from '../components/DayGrid';
import { PlatePreview } from '../../booking/components/PlatePreview';
import { Btn, Drawer, ErrorBox, InfoBox, Input, SelectField, TextArea, Toggle } from '../components/controls';
import { DurationSelect, StationSelect, TimeSelect } from '../components/TimeFields';

type Prefill = SlotClick | { day: string };

function useDebounced<T>(v: T, ms = 250) {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

/** Usługi pogrupowane wg kategorii (kolejność jak z serwera); bez kategorii = jedna płaska lista. */
function groupServices(list: AdminService[]): [string | null, AdminService[]][] {
  const groups = new Map<string | null, AdminService[]>();
  for (const s of list) groups.set(s.category, [...(groups.get(s.category) ?? []), s]);
  return [...groups.entries()];
}

export function NewAppointmentDrawer({ prefill, onClose, onCreated }: { prefill: Prefill; onClose: () => void; onCreated: (id: string, day: string) => void }) {
  const qc = useQueryClient();
  const services = useAdminServices();
  const [day, setDay] = useState(prefill.day);
  const [time, setTime] = useState('minute' in prefill ? hhmm(prefill.minute) : '08:00');
  const [station, setStation] = useState('stationId' in prefill ? String(prefill.stationId) : '');
  const [serviceId, setServiceId] = useState<number | null>(null);
  const [duration, setDuration] = useState(15);
  const [source, setSource] = useState<'phone' | 'walk_in'>('phone');
  const [phone, setPhone] = useState('');
  const [fullName, setFullName] = useState('');
  const [customer, setCustomer] = useState<CustomerRow | null>(null);
  const [vehicleId, setVehicleId] = useState<string>('new');
  const [plate, setPlate] = useState(''); const [make, setMake] = useState(''); const [model, setModel] = useState('');
  const [adminNotes, setAdminNotes] = useState('');
  const [notify, setNotify] = useState(true);
  const [optIn, setOptIn] = useState(false);
  const [needsOutside, setNeedsOutside] = useState(false);
  const [idemKey] = useState(() => crypto.randomUUID());
  const cal = useCalendar(day, day);

  // domyślna usługa i czas trwania
  useEffect(() => {
    if (serviceId === null && services.data?.[0]) { setServiceId(services.data[0].id); setDuration(services.data[0].durationMinutes); }
  }, [services.data, serviceId]);
  useEffect(() => { setNotify(source === 'phone'); }, [source]);

  // podpowiedzi klientów po numerze telefonu
  const digits = useDebounced(phone.replace(/\D/g, ''));
  const matches = useQuery({
    queryKey: ['customers', digits],
    queryFn: () => adminApi<{ customers: CustomerRow[] }>(`/customers?q=${digits}&limit=5`).then((r) => r.customers),
    enabled: digits.length >= 3 && !customer,
  });
  const card = useQuery({
    queryKey: ['customer', customer?.id],
    queryFn: () => adminApi<{ customer: CustomerCard }>(`/customers/${customer!.id}`).then((r) => r.customer),
    enabled: !!customer,
  });
  useEffect(() => {
    const v = card.data?.vehicles.filter((x) => x.registrationNumber);
    setVehicleId(v?.length ? v[v.length - 1]!.id : 'new');
  }, [card.data]);

  const create = useMutation({
    mutationFn: (allowOutsideHours: boolean) => adminApi<{ appointment: AppointmentDetail; existingCustomer: boolean }>('/appointments', {
      method: 'POST',
      headers: { 'Idempotency-Key': idemKey },
      json: {
        serviceId, startsAt: zonedToDate(day, time).toISOString(), durationMinutes: duration, source,
        ...(station ? { stationId: Number(station) } : {}),
        customer: customer ? { customerId: customer.id } : { fullName: fullName.trim(), phone: phone.trim() },
        vehicle: vehicleId !== 'new' ? { vehicleId } : { make: make.trim(), model: model.trim(), registrationNumber: plate.toUpperCase().replace(/[\s-]/g, '') },
        ...(adminNotes.trim() ? { adminNotes: adminNotes.trim() } : {}),
        notifyCustomer: notify, whatsappOptIn: optIn, allowOutsideHours,
      },
    }),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['cal'] }); onCreated(r.appointment.id, day); },
    onError: (e) => { if (e instanceof ApiError && e.code === 'OUTSIDE_BUSINESS_HOURS') setNeedsOutside(true); },
  });

  const service = useMemo(() => services.data?.find((s) => s.id === serviceId), [services.data, serviceId]);
  const vehicles = card.data?.vehicles.filter((v) => v.registrationNumber) ?? [];

  return (
    <Drawer
      title="Nowa wizyta"
      onClose={onClose}
      footer={needsOutside
        ? <div className="space-y-2"><InfoBox>Ten termin jest poza godzinami pracy serwisu.</InfoBox>
            <div className="flex gap-2"><Btn busy={create.isPending} onClick={() => create.mutate(true)}>Dodaj mimo to</Btn><Btn variant="ghost" onClick={() => setNeedsOutside(false)}>Zmień godzinę</Btn></div></div>
        : <Btn type="submit" form="new-appt" busy={create.isPending} className="w-full">Dodaj wizytę</Btn>}
    >
      <form id="new-appt" className="space-y-5" onSubmit={(e) => { e.preventDefault(); setNeedsOutside(false); create.mutate(false); }}>
        {create.isError && !needsOutside && <ErrorBox>{adminErrorMessage(create.error)}</ErrorBox>}

        <fieldset className="space-y-3">
          <legend className="mb-2 font-display text-[1.3rem] font-bold">Termin</legend>
          <SelectField label="Usługa" value={serviceId ?? ''} onChange={(e) => {
            const s = services.data?.find((x) => x.id === Number(e.target.value));
            if (s) { setServiceId(s.id); setDuration(s.durationMinutes); }
          }}>
            {groupServices(services.data ?? []).map(([category, list]) => {
              const options = list.map((s) => <option key={s.id} value={s.id}>{s.shortName ?? s.name}{s.isPublic ? '' : ' (tylko w panelu)'}</option>);
              return category ? <optgroup key={category} label={category}>{options}</optgroup> : options;
            })}
          </SelectField>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Dzień" type="date" required value={day} onChange={(e) => setDay(e.target.value)} />
            <TimeSelect value={time} onChange={setTime} />
            <StationSelect value={station} onChange={setStation} stations={cal.data?.stations ?? []} />
            <DurationSelect value={duration} onChange={setDuration} />
          </div>
          {service && duration !== service.durationMinutes && <p className="text-[0.88rem] text-muted">Standardowo {service.durationMinutes} min.</p>}
          <div className="flex rounded-lg border-2 border-line bg-paper p-0.5" role="group" aria-label="Skąd wizyta">
            {([['phone', 'Telefonicznie'], ['walk_in', 'Klient na miejscu']] as const).map(([v, l]) => (
              <button key={v} type="button" aria-pressed={source === v} onClick={() => setSource(v)}
                className={`flex-1 rounded-md px-3 py-2 text-[0.95rem] font-semibold ${source === v ? 'bg-ink text-white' : 'text-muted'}`}>{l}</button>
            ))}
          </div>
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="mb-2 font-display text-[1.3rem] font-bold">Klient</legend>
          {customer ? (
            <div className="flex items-start justify-between gap-3 rounded-xl bg-paper px-4 py-3">
              <div><p className="font-semibold">{customer.fullName}</p><p className="tabular-nums text-muted">{fmtPhone(customer.phone)}</p>
                <p className="text-[0.88rem] text-muted">{customer.completedVisits} wizyt{customer.noShows ? `, ${customer.noShows}× nie przyjechał` : ''}</p></div>
              <Btn type="button" variant="ghost" onClick={() => { setCustomer(null); setPhone(''); }}>Zmień</Btn>
            </div>
          ) : (
            <>
              <Input label="Telefon" type="tel" inputMode="tel" required value={phone} onChange={(e) => setPhone(e.target.value)} hint="Wpisz numer — podpowiemy, jeśli klient już był." />
              {matches.data && matches.data.length > 0 && (
                <ul className="divide-y divide-line overflow-hidden rounded-xl bg-paper" aria-label="Znalezieni klienci">
                  {matches.data.map((c) => (
                    <li key={c.id}><button type="button" onClick={() => setCustomer(c)} className="w-full px-4 py-2.5 text-left hover:bg-[#fff6d6]">
                      <span className="font-semibold">{c.fullName}</span> <span className="tabular-nums text-muted">{fmtPhone(c.phone)}</span>
                      {c.plates.length > 0 && <span className="block text-[0.88rem] text-muted">{c.plates.join(', ')}</span>}
                    </button></li>
                  ))}
                </ul>
              )}
              <Input label="Imię i nazwisko" required value={fullName} onChange={(e) => setFullName(e.target.value)} autoComplete="off" />
            </>
          )}
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="mb-2 font-display text-[1.3rem] font-bold">Samochód</legend>
          {vehicles.length > 0 && (
            <SelectField label="Pojazd" value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
              {vehicles.map((v) => <option key={v.id} value={v.id}>{v.registrationNumber}, {v.make} {v.model}</option>)}
              <option value="new">Inny samochód…</option>
            </SelectField>
          )}
          {vehicleId === 'new' && (
            <>
              <Input label="Numer rejestracyjny" required autoCapitalize="characters" value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} maxLength={12} />
              <PlatePreview value={plate} />
              <div className="grid grid-cols-2 gap-3">
                <Input label="Marka" required value={make} onChange={(e) => setMake(e.target.value)} />
                <Input label="Model" required value={model} onChange={(e) => setModel(e.target.value)} />
              </div>
            </>
          )}
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="sr-only">Powiadomienia i notatki</legend>
          <TextArea label="Notatka warsztatu (opcjonalnie)" value={adminNotes} onChange={(e) => setAdminNotes(e.target.value)} maxLength={2000} />
          <Toggle checked={notify} onChange={setNotify}>Wyślij potwierdzenie i przypomnienie</Toggle>
          {!(customer && card.data?.whatsappOptIn) && (
            <Toggle checked={optIn} onChange={setOptIn}>Klient zgodził się na wiadomości WhatsApp (zapytaj przed zaznaczeniem)</Toggle>
          )}
          {customer && card.data?.whatsappOptIn && <p className="text-[0.92rem] text-ok">Klient ma zgodę na WhatsApp.</p>}
        </fieldset>
      </form>
    </Drawer>
  );
}
