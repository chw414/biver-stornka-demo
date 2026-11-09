import { useMemo } from 'react';
import { makeFormatters } from '../format';
import type { BookedAppointment, PublicInfo } from '../types';
import { PrimaryButton, TextButton } from '../../shared/ui';

const icsEscape = (s: string) => s.replace(/\\/g, '\\\\').replace(/[,;]/g, (c) => `\\${c}`).replace(/\n/g, '\\n');
const icsDate = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** Plik .ics generowany w przeglądarce — działa z Kalendarzem Google, Apple i Outlookiem, bez dodatkowego API. */
function downloadIcs(a: BookedAppointment, info: PublicInfo) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//serwis//rezerwacje//PL', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${a.referenceCode}@rezerwacje`,
    `DTSTAMP:${icsDate(new Date().toISOString())}`,
    `DTSTART:${icsDate(a.startsAt)}`,
    `DTEND:${icsDate(a.endsAt)}`,
    `SUMMARY:${icsEscape(`${a.serviceName} — ${info.businessName}`)}`,
    info.address ? `LOCATION:${icsEscape(info.address)}` : '',
    `DESCRIPTION:${icsEscape(`Numer rezerwacji: ${a.referenceCode}\nPłatność na miejscu.${info.phone ? `\nTelefon: ${info.phone}` : ''}`)}`,
    'BEGIN:VALARM', 'TRIGGER:-PT2H', 'ACTION:DISPLAY', 'DESCRIPTION:Wizyta w serwisie', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean);
  const url = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `wizyta-${a.referenceCode}.ics`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ConfirmationStep({ appointment, info, plate, whatsapp, onNew }: {
  appointment: BookedAppointment; info: PublicInfo; plate: string; whatsapp: boolean; onNew: () => void;
}) {
  const fmt = useMemo(() => makeFormatters(info.timezone), [info.timezone]);
  const start = new Date(appointment.startsAt);
  // przypomnienie powstaje tylko, gdy jego moment wysyłki (24 h przed wizytą) jest jeszcze przed nami
  const willRemind = start.getTime() - 24 * 3_600_000 > Date.now();
  return (
    <div className="space-y-6">
      <div className="overflow-hidden rounded-xl bg-paper">
        <div className="bg-asphalt px-5 py-5 text-white">
          <p className="text-[#c3c8cc] first-letter:uppercase">{fmt.dayLong(start)}</p>
          <p className="font-display text-[3.4rem] font-bold leading-none tabular-nums text-signal">{fmt.time(start)}</p>
        </div>
        <dl className="divide-y divide-line px-5">
          <div className="flex justify-between gap-4 py-3"><dt className="text-muted">Usługa</dt><dd className="text-right font-semibold">{appointment.serviceName}</dd></div>
          <div className="flex justify-between gap-4 py-3"><dt className="text-muted">Samochód</dt><dd className="text-right font-semibold">{plate}</dd></div>
          <div className="flex items-baseline justify-between gap-4 py-3">
            <dt className="text-muted">Numer rezerwacji</dt>
            <dd className="font-display text-[1.6rem] font-bold tracking-[0.12em]">{appointment.referenceCode}</dd>
          </div>
          {info.address && <div className="flex justify-between gap-4 py-3"><dt className="text-muted">Adres</dt><dd className="text-right">{info.address}</dd></div>}
        </dl>
      </div>

      <p>
        Płatność na miejscu.{' '}
        {whatsapp
          ? (willRemind ? 'Potwierdzenie i przypomnienie dzień przed wizytą wyślemy na WhatsApp.' : 'Potwierdzenie wyślemy na WhatsApp.')
          : 'Zapisz numer rezerwacji — przyda się przy zmianie terminu.'}
        {info.phone && <> Zmiana lub odwołanie: <a className="font-semibold underline" href={`tel:${info.phone.replace(/\s/g, '')}`}>{info.phone}</a>.</>}
      </p>

      <div className="space-y-4">
        <PrimaryButton type="button" onClick={() => downloadIcs(appointment, info)}>Dodaj do kalendarza</PrimaryButton>
        <div className="text-center"><TextButton type="button" onClick={onNew}>Zarezerwuj kolejną wizytę</TextButton></div>
      </div>
    </div>
  );
}
