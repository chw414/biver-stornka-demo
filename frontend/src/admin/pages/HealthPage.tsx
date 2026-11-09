import { useQuery } from '@tanstack/react-query';
import { adminApi } from '../api';
import { fmtDateTime } from '../time';
import type { Health } from '../types';
import { ErrorBox, InfoBox } from '../components/controls';

/** Kody błędów przetłumaczone na to, co właściciel może z nimi zrobić. */
const ERRORS: Record<string, string> = {
  '131026': 'Numer nie ma WhatsAppa (albo stara wersja aplikacji). Włącz SMS jako kanał zapasowy, żeby ci klienci dostawali przypomnienia.',
  '132001': 'Szablon wiadomości nie istnieje lub nie jest zatwierdzony w Meta. Sprawdź WhatsApp Manager.',
  '132015': 'Meta wstrzymała szablon z powodu niskiej jakości (klienci zgłaszali spam). Popraw treść szablonu.',
  '131042': 'Problem z płatnościami w koncie WhatsApp Business.',
  '190': 'Token dostępu WhatsApp wygasł — wygeneruj nowy token System User.',
  NO_CHANNEL: 'Klient nie wyraził zgody na WhatsApp, a SMS nie jest włączony.',
};

export function HealthPage() {
  const h = useQuery({ queryKey: ['health'], queryFn: () => adminApi<Health>('/system/health'), refetchInterval: 60_000 });
  const d = h.data;
  return (
    <div className="mx-auto max-w-3xl space-y-6 px-3 py-5 sm:px-5">
      <h1 className="font-display text-[2rem] font-bold">Powiadomienia i kalendarz</h1>
      {h.isError && <ErrorBox>{h.error.message}</ErrorBox>}
      {d && (
        <>
          {(d.notifications.overdue > 0 || d.calendarSync.failed > 0) && (
            <ErrorBox>
              {d.notifications.overdue > 0 && <p>{d.notifications.overdue} wiadomości czeka na wysłanie dłużej niż 10 minut — sprawdź, czy działa proces workera.</p>}
              {d.calendarSync.failed > 0 && <p>{d.calendarSync.failed} zmian nie trafiło do Kalendarza Google. Sprawdź konto serwisowe i udostępnienie kalendarza.</p>}
            </ErrorBox>
          )}
          {d.notifications.overdue === 0 && d.calendarSync.failed === 0 && <InfoBox>Wszystko działa.</InfoBox>}
          {(d.whatsappMode !== 'cloud' || d.calendarMode !== 'api') && (
            <InfoBox>Tryb testowy: {d.whatsappMode !== 'cloud' && 'wiadomości nie są naprawdę wysyłane'}{d.whatsappMode !== 'cloud' && d.calendarMode !== 'api' && ', '}{d.calendarMode !== 'api' && 'Kalendarz Google nie jest połączony'}.</InfoBox>
          )}
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[['Wysłane (7 dni)', d.notifications.sent7d], ['Nieudane (7 dni)', d.notifications.failed7d], ['Bez kanału (7 dni)', d.notifications.noChannel7d], ['Do kalendarza w kolejce', d.calendarSync.pending]].map(([l, v]) => (
              <div key={l} className="rounded-xl bg-paper px-4 py-3">
                <dt className="text-[0.88rem] text-muted">{l}</dt>
                <dd className="font-display text-[2rem] font-bold tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="text-[0.95rem]">Kolejność kanałów: <span className="font-semibold">{d.notificationChannels.map((c) => (c === 'whatsapp' ? 'WhatsApp' : 'SMS')).join(', potem ')}</span></p>
          {d.notifications.topErrors.length > 0 && (
            <section>
              <h2 className="mb-2 font-display text-[1.4rem] font-bold">Najczęstsze problemy</h2>
              <ul className="divide-y divide-line rounded-xl bg-paper">
                {d.notifications.topErrors.map((e) => (
                  <li key={`${e.code}-${e.channel}`} className="px-4 py-3">
                    <p className="font-semibold">{e.count}× {e.channel === 'sms' ? 'SMS' : 'WhatsApp'}, kod {e.code} <span className="font-normal text-muted">(ostatnio {fmtDateTime(e.lastAt)})</span></p>
                    <p className="text-[0.95rem]">{ERRORS[e.code] ?? 'Szczegóły w logach workera.'}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
