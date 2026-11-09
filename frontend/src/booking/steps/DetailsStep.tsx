import { forwardRef, useImperativeHandle, useRef } from 'react';
import type { DetailsErrors, DetailsForm } from '../validation';
import type { LegalDoc } from '../types';
import { PlatePreview } from '../components/PlatePreview';
import { Checkbox, Field } from '../../shared/ui';

export interface DetailsStepHandle { focusFirstError: (errors: DetailsErrors) => void }

const ORDER: (keyof DetailsForm)[] = ['fullName', 'phone', 'registrationNumber', 'make', 'model', 'notes', 'acceptTerms'];

export const DetailsStep = forwardRef<DetailsStepHandle, {
  form: DetailsForm; errors: DetailsErrors; onChange: (patch: Partial<DetailsForm>) => void;
  businessName: string; terms: LegalDoc | null; privacy: LegalDoc | null; whatsapp: LegalDoc | null;
}>(function DetailsStep({ form, errors, onChange, businessName, terms, privacy, whatsapp }, ref) {
  const refs = useRef<Partial<Record<keyof DetailsForm, HTMLInputElement | null>>>({});
  const bind = (k: keyof DetailsForm) => (el: HTMLInputElement | null) => { refs.current[k] = el; };

  useImperativeHandle(ref, () => ({
    focusFirstError(e) {
      const first = ORDER.find((k) => e[k]);
      if (first) refs.current[first]?.focus();
    },
  }));

  const set = (k: keyof DetailsForm) => (e: React.ChangeEvent<HTMLInputElement>) => onChange({ [k]: e.target.value });

  return (
    <div className="space-y-8">
      <fieldset className="space-y-4">
        <legend className="mb-3 font-display text-[1.45rem] font-bold">Kontakt</legend>
        <Field ref={bind('fullName')} label="Imię i nazwisko" autoComplete="name" value={form.fullName} onChange={set('fullName')} error={errors.fullName} maxLength={120} />
        <Field
          ref={bind('phone')}
          label="Telefon komórkowy"
          hint="Na ten numer wyślemy potwierdzenie i przypomnienie."
          type="tel" inputMode="tel" autoComplete="tel-national" prefix="+48"
          value={form.phone} onChange={set('phone')} error={errors.phone} maxLength={20}
          placeholder="600 100 200"
        />
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="mb-3 font-display text-[1.45rem] font-bold">Samochód</legend>
        <div>
          <Field
            ref={bind('registrationNumber')}
            label="Numer rejestracyjny"
            autoCapitalize="characters" autoComplete="off" spellCheck={false}
            value={form.registrationNumber}
            onChange={(e) => onChange({ registrationNumber: e.target.value.toUpperCase() })}
            error={errors.registrationNumber} maxLength={12}
          />
          <div className="mt-3"><PlatePreview value={form.registrationNumber} invalid={!!errors.registrationNumber} /></div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field ref={bind('make')} label="Marka" autoComplete="off" value={form.make} onChange={set('make')} error={errors.make} maxLength={50} placeholder="Toyota" />
          <Field ref={bind('model')} label="Model" autoComplete="off" value={form.model} onChange={set('model')} error={errors.model} maxLength={60} placeholder="Corolla" />
        </div>
        <Field
          ref={bind('notes')}
          label="Uwagi (opcjonalnie)"
          hint="Np. opony w bagażniku, felgi aluminiowe, czujniki ciśnienia."
          value={form.notes} onChange={set('notes')} error={errors.notes} maxLength={500}
        />
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="sr-only">Zgody</legend>
        <Checkbox
          inputRef={bind('acceptTerms')}
          checked={form.acceptTerms}
          onChange={(v) => onChange({ acceptTerms: v })}
          error={errors.acceptTerms}
        >
          Akceptuję{' '}
          {terms ? <a href={terms.url} target="_blank" rel="noopener" className="font-semibold underline">regulamin</a> : 'regulamin'}
          {' '}i zapoznałem/am się z{' '}
          {privacy ? <a href={privacy.url} target="_blank" rel="noopener" className="font-semibold underline">informacją o przetwarzaniu danych</a> : 'informacją o przetwarzaniu danych'}.
        </Checkbox>
        {whatsapp?.text && (
          <Checkbox checked={form.whatsappOptIn} onChange={(v) => onChange({ whatsappOptIn: v })}>
            {/* dokładnie ta treść jest zapisana jako dowód zgody (legal_documents) */}
            {whatsapp.text}
          </Checkbox>
        )}
        {!whatsapp?.text && <p className="text-[0.92rem] text-muted">Szczegóły wizyty otrzymasz od {businessName}.</p>}
      </fieldset>
    </div>
  );
});
