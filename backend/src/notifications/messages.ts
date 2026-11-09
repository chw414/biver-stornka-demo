import { config } from '../config.js';
import type { NotificationKind, RenderedMessage } from './channels/types.js';

export interface MessageData {
  kind: NotificationKind;
  serviceName: string;
  startsAt: Date;
  referenceCode: string;
  timezone: string;
}

/**
 * Parametry szablonów WhatsApp (kolejność = {{1}}, {{2}}, ...) i tekst dla SMS/logów.
 * Bez imienia i nazwiska klienta — minimalizacja danych (RODO); nie jest potrzebne do przypomnienia.
 */
export function renderMessage(d: MessageData): RenderedMessage {
  const date = new Intl.DateTimeFormat('pl-PL', { timeZone: d.timezone, weekday: 'long', day: 'numeric', month: 'long' }).format(d.startsAt);
  const time = new Intl.DateTimeFormat('pl-PL', { timeZone: d.timezone, hour: '2-digit', minute: '2-digit' }).format(d.startsAt);
  const biz = config.BUSINESS_NAME;

  switch (d.kind) {
    case 'confirmation':
      return { kind: d.kind, templateParams: [d.serviceName, date, time, d.referenceCode],
        text: `${biz}: potwierdzamy wizytę — ${d.serviceName}, ${date}, godz. ${time}. Nr rezerwacji: ${d.referenceCode}. Płatność na miejscu.` };
    case 'reminder_24h':
      return { kind: d.kind, templateParams: [d.serviceName, date, time, d.referenceCode],
        text: `${biz}: przypominamy o wizycie jutro — ${d.serviceName}, ${date}, godz. ${time}. Nr rezerwacji: ${d.referenceCode}.` };
    case 'reschedule':
      return { kind: d.kind, templateParams: [d.serviceName, date, time, d.referenceCode],
        text: `${biz}: zmieniliśmy termin Twojej wizyty — ${d.serviceName}, ${date}, godz. ${time}. Nr rezerwacji: ${d.referenceCode}.` };
    case 'cancellation':
      return { kind: d.kind, templateParams: [date, time, d.referenceCode],
        text: `${biz}: wizyta ${date}, godz. ${time} (nr ${d.referenceCode}) została odwołana. Zapraszamy do ponownej rezerwacji.` };
  }
}
