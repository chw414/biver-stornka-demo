import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../shared/api';
import { formatDuration, labelFromIso, makeFormatters } from './format';
import { useCreateBooking, useInfo, useServices } from './queries';
import type { BookedAppointment, Service, Slot } from './types';
import { SERVER_FIELD_MAP, normalizePlate, validateDetails, type DetailsErrors, type DetailsForm } from './validation';
import { Shell } from './components/Shell';
import { formatPlate } from './components/PlatePreview';
import { Alert, PrimaryButton, TextButton } from '../shared/ui';
import { ServiceStep } from './steps/ServiceStep';
import { DateTimeStep } from './steps/DateTimeStep';
import { DetailsStep, type DetailsStepHandle } from './steps/DetailsStep';
import { ConfirmationStep } from './steps/ConfirmationStep';

type Step = 'service' | 'time' | 'details' | 'done';
const STEP_INDEX: Record<Step, number | null> = { service: 1, time: 2, details: 3, done: null };

interface State {
  step: Step;
  service: Service | null;
  date: string | null;
  slot: Slot | null;
  form: DetailsForm;
  /** Klucz idempotencji: jeden na próbę rezerwacji danego terminu (ponowne kliknięcie / słaby zasięg = ta sama rezerwacja) */
  idempotencyKey: string;
  notice: string | null;
  booked: BookedAppointment | null;
}

const emptyForm: DetailsForm = { fullName: '', phone: '', make: '', model: '', registrationNumber: '', notes: '', acceptTerms: false, whatsappOptIn: false };
const initial = (): State => ({ step: 'service', service: null, date: null, slot: null, form: emptyForm, idempotencyKey: crypto.randomUUID(), notice: null, booked: null });

type Action =
  | { type: 'goto'; step: Step }
  | { type: 'service'; service: Service }
  | { type: 'date'; date: string }
  | { type: 'slot'; slot: Slot }
  | { type: 'form'; patch: Partial<DetailsForm> }
  | { type: 'slotLost'; notice: string }
  | { type: 'booked'; appointment: BookedAppointment }
  | { type: 'reset'; keepContact: boolean };

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'goto': return { ...s, step: a.step, notice: a.step === 'time' ? s.notice : null };
    case 'service':
      return s.service?.id === a.service.id ? { ...s, step: 'time' }
        : { ...s, service: a.service, date: null, slot: null, step: 'time', notice: null, idempotencyKey: crypto.randomUUID() };
    case 'date': return { ...s, date: a.date, slot: s.date === a.date ? s.slot : null };
    // inny termin = nowa rezerwacja = nowy klucz idempotencji
    case 'slot': return { ...s, slot: a.slot, notice: null, idempotencyKey: s.slot?.startsAt === a.slot.startsAt ? s.idempotencyKey : crypto.randomUUID() };
    case 'form': return { ...s, form: { ...s.form, ...a.patch } };
    case 'slotLost': return { ...s, step: 'time', slot: null, notice: a.notice, idempotencyKey: crypto.randomUUID() };
    case 'booked': return { ...s, step: 'done', booked: a.appointment };
    case 'reset': {
      const fresh = initial();
      // kolejna wizyta tej samej osoby: zachowaj dane kontaktowe i samochód, zgody trzeba wyrazić ponownie
      return a.keepContact ? { ...fresh, form: { ...s.form, notes: '', acceptTerms: false, whatsappOptIn: false } } : fresh;
    }
  }
}

export function BookingApp() {
  const [s, dispatch] = useReducer(reducer, undefined, initial);
  const info = useInfo();
  const services = useServices();
  const booking = useCreateBooking();
  const qc = useQueryClient();
  const detailsRef = useRef<DetailsStepHandle>(null);
  const [errors, setErrors] = useState<DetailsErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const fmt = useMemo(() => makeFormatters(info.data?.timezone ?? 'Europe/Warsaw'), [info.data?.timezone]);

  // ---------- przycisk "wstecz" telefonu = poprzedni krok (a nie wyjście ze strony) ----------
  const goto = useCallback((step: Step, replace = false) => {
    dispatch({ type: 'goto', step });
    if (replace) history.replaceState({ step }, '');
    else history.pushState({ step }, '');
    window.scrollTo({ top: 0 });
  }, []);
  useEffect(() => {
    history.replaceState({ step: 'service' }, '');
    const onPop = (e: PopStateEvent) => {
      const step = (e.state?.step as Step | undefined) ?? 'service';
      dispatch(step === 'done' ? { type: 'reset', keepContact: true } : { type: 'goto', step });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const onDate = useCallback((date: string) => dispatch({ type: 'date', date }), []);

  async function submit() {
    if (!s.service || !s.slot) return;
    setSubmitError(null);
    const v = validateDetails(s.form);
    setErrors(v);
    if (Object.keys(v).length) { detailsRef.current?.focusFirstError(v); return; }

    try {
      const appointment = await booking.mutateAsync({
        idempotencyKey: s.idempotencyKey,
        body: {
          serviceId: s.service.id,
          startsAt: s.slot.startsAt,
          fullName: s.form.fullName.trim(),
          phone: s.form.phone.trim(),
          vehicle: { make: s.form.make.trim(), model: s.form.model.trim(), registrationNumber: normalizePlate(s.form.registrationNumber) },
          ...(s.form.notes.trim() ? { notes: s.form.notes.trim() } : {}),
          acceptTerms: true,
          whatsappOptIn: s.form.whatsappOptIn,
        },
      });
      dispatch({ type: 'booked', appointment });
      history.replaceState({ step: 'done' }, '');
      window.scrollTo({ top: 0 });
      qc.invalidateQueries({ queryKey: ['slots'] });
      qc.invalidateQueries({ queryKey: ['days'] });
    } catch (err) {
      if (!(err instanceof ApiError)) { setSubmitError('Coś poszło nie tak. Spróbuj ponownie.'); return; }
      if (err.code === 'SLOT_TAKEN' || err.code === 'SLOT_UNAVAILABLE') {
        // termin zajęty w międzyczasie — wróć do wyboru godziny, dane formularza zostają
        qc.invalidateQueries({ queryKey: ['slots'] });
        qc.invalidateQueries({ queryKey: ['days'] });
        dispatch({ type: 'slotLost', notice: `Godzina ${fmt.time(s.slot.startsAt)} została właśnie zajęta. Wybierz inną — Twoje dane są zapamiętane.` });
        history.back();
        return;
      }
      if (err.code === 'VALIDATION_ERROR') {
        const mapped: DetailsErrors = {};
        for (const [path, msg] of Object.entries(err.fieldErrors())) {
          const k = SERVER_FIELD_MAP[path];
          if (k) mapped[k] = msg;
        }
        setErrors(mapped);
        detailsRef.current?.focusFirstError(mapped);
        if (!Object.keys(mapped).length) setSubmitError(err.message);
        return;
      }
      if (err.status === 429) {
        const min = err.retryAfterSec ? Math.ceil(err.retryAfterSec / 60) : null;
        setSubmitError(`Zbyt wiele prób rezerwacji z tego urządzenia lub numeru.${min ? ` Spróbuj za ${min} min` : ' Spróbuj później'} albo zadzwoń.`);
        return;
      }
      setSubmitError(err.message);
    }
  }

  const i = info.data;

  // ---------- ekrany ----------
  if (s.step === 'done' && s.booked && i) {
    return (
      <Shell info={i} step={null} title="Wizyta zarezerwowana">
        <ConfirmationStep
          appointment={s.booked} info={i} plate={formatPlate(s.form.registrationNumber)} whatsapp={s.form.whatsappOptIn}
          onNew={() => { dispatch({ type: 'reset', keepContact: true }); history.replaceState({ step: 'service' }, ''); }}
        />
      </Shell>
    );
  }

  if (s.step === 'time' && s.service && i) {
    return (
      <Shell
        info={i} step={2} title="Wybierz termin"
        footer={
          <div className="space-y-2.5">
            <p className="text-[0.95rem]">
              <span className="font-semibold">{s.service.name}</span>
              <span className="text-muted"> ({formatDuration(s.service.durationMinutes)})</span>{' '}
              <TextButton type="button" className="ml-1 text-[0.95rem]" onClick={() => history.back()}>Zmień usługę</TextButton>
            </p>
            <PrimaryButton type="button" disabled={!s.slot} onClick={() => goto('details')}>
              {s.slot ? `Dalej: ${fmt.dayShort(labelFromIso(s.date!))}, ${fmt.time(s.slot.startsAt)}` : 'Wybierz godzinę'}
            </PrimaryButton>
          </div>
        }
      >
        <DateTimeStep
          service={s.service} timezone={i.timezone} horizonDays={i.bookingHorizonDays}
          date={s.date} slot={s.slot} notice={s.notice}
          onDate={onDate} onSlot={(slot) => dispatch({ type: 'slot', slot })}
        />
      </Shell>
    );
  }

  if (s.step === 'details' && s.service && s.slot && s.date && i) {
    return (
      <Shell
        info={i} step={3} title="Twoje dane"
        footer={<PrimaryButton type="submit" form="details-form" busy={booking.isPending}>{booking.isPending ? 'Rezerwuję…' : 'Zarezerwuj wizytę'}</PrimaryButton>}
      >
        <div className="mb-6 rounded-xl bg-paper px-4 py-3">
          <p className="font-semibold">{s.service.name}</p>
          <p className="text-muted first-letter:uppercase">{fmt.dayLong(labelFromIso(s.date))}, godz. {fmt.time(s.slot.startsAt)}</p>
          <TextButton type="button" className="mt-1 text-[0.95rem]" onClick={() => history.back()}>Zmień termin</TextButton>
        </div>
        <form id="details-form" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <DetailsStep
            ref={detailsRef}
            form={s.form} errors={errors}
            onChange={(patch) => {
              dispatch({ type: 'form', patch });
              // błąd pola znika, gdy klient je poprawia
              setErrors((prev) => { const n = { ...prev }; for (const k of Object.keys(patch)) delete n[k as keyof DetailsForm]; return n; });
            }}
            businessName={i.businessName} terms={i.legal.terms} privacy={i.legal.privacy} whatsapp={i.whatsappConsent}
          />
        </form>
        {submitError && <div className="mt-6"><Alert>{submitError}</Alert></div>}
      </Shell>
    );
  }

  return (
    <Shell info={i} step={1} title="Co robimy?">
      {info.isError && <div className="mb-4"><Alert>Nie udało się połączyć z serwisem. {info.error.message}</Alert></div>}
      <ServiceStep
        services={services.data} loading={services.isPending || info.isPending} error={services.error}
        selectedId={s.service?.id ?? null} priceInfo={i?.priceInfo ?? null}
        onSelect={(service) => { dispatch({ type: 'service', service }); history.pushState({ step: 'time' }, ''); window.scrollTo({ top: 0 }); }}
        onRetry={() => { void services.refetch(); void info.refetch(); }}
      />
      <p className="mt-6 text-[0.95rem] text-muted">Płacisz na miejscu, po wykonaniu usługi. Rezerwacja nie wymaga zakładania konta.</p>
    </Shell>
  );
}
