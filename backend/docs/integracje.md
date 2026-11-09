# Integracje: WhatsApp, (przyszły) SMS, Google Calendar

## Architektura w skrócie
API niczego nie wysyła samo. Rezerwacja zapisuje w tej samej transakcji rekordy `notifications`
(CO i KIEDY wysłać) oraz `outbox_events` (zmiany do Google Calendar). Osobny proces `npm run worker`
je realizuje. Kanał (WhatsApp / SMS) wybierany jest **w chwili wysyłki** według
`app_settings.notification_channels` i zgód klienta.

| `notification_channels` | Zachowanie |
|---|---|
| `["whatsapp"]` (domyślnie) | Tylko WhatsApp; klient bez zgody nie dostaje wiadomości |
| `["whatsapp","sms"]` | WhatsApp, a SMS gdy brak zgody, numer bez WhatsAppa (131026) lub trwały błąd |
| `["sms"]` | Tylko SMS |

**Dodanie SMS:** klasa implementująca `MessageChannel` (`src/notifications/channels/types.ts`),
rejestracja w `registry.ts`, zmiana ustawienia. Treść SMS jest już generowana (`messages.ts`).

## WhatsApp — konfiguracja (Meta)
1. Meta Business Portfolio + aplikacja w developers.facebook.com z przypadkiem użycia „Connect with customers through WhatsApp”.
2. Numer telefonu dla WhatsApp Business Platform, zatwierdzona nazwa wyświetlana, metoda płatności.
3. **System User** z uprawnieniami `whatsapp_business_messaging` → bezterminowy token → `WHATSAPP_ACCESS_TOKEN`.
4. Szablony (poniżej) w WhatsApp Manager, kategoria **Utility**, język **polski (pl)**.
5. Webhook: `https://<domena>/api/webhooks/whatsapp`, Verify token = `WHATSAPP_VERIFY_TOKEN`,
   subskrypcja pola **messages**. `WHATSAPP_APP_SECRET` = App Secret aplikacji (podpis HMAC).
6. `WHATSAPP_MODE=cloud`. Sprawdź aktualną wersję Graph API (`WHATSAPP_GRAPH_VERSION`).

Szablony utility są płatne za wiadomość wg stawek krajowych Meta — sprawdź aktualny cennik.

### Zgoda (opt-in) — wymagana przez Meta
Osobny, **niezaznaczony domyślnie** checkbox w formularzu. Tekst zgody opublikuj w `legal_documents`
(`kind='whatsapp'`, hash dokładnej treści), np.:

> Chcę otrzymać potwierdzenie i przypomnienie o wizycie na WhatsApp od **[Nazwa serwisu]**.
> Mogę zrezygnować w każdej chwili, odpisując STOP.

Rezygnacja: odpowiedź `STOP` / `NIE` / `WYPISZ` (webhook) albo admin w karcie klienta.

### Szablony do zgłoszenia (Utility, pl)
Zmienne nie mogą stać na początku ani na końcu treści. W miejsce [Nazwa serwisu] wpisz nazwę na stałe.
Stopka każdego szablonu: `Odpisz STOP, aby nie otrzymywać wiadomości.`

**potwierdzenie_wizyty** — `{{1}}` usługa, `{{2}}` data, `{{3}}` godzina, `{{4}}` nr rezerwacji
```
Dzień dobry! Potwierdzamy rezerwację w [Nazwa serwisu].
Usługa: {{1}}
Termin: {{2}}, godz. {{3}}
Numer rezerwacji: {{4}}
Płatność na miejscu. Do zobaczenia!
```
**przypomnienie_wizyty** — te same zmienne
```
Przypominamy o jutrzejszej wizycie w [Nazwa serwisu].
Usługa: {{1}}
Termin: {{2}}, godz. {{3}}
Numer rezerwacji: {{4}}
Jeśli nie możesz przyjechać, zadzwoń do nas — zwolnimy termin dla innych klientów.
```
**zmiana_terminu_wizyty** — te same zmienne
```
Termin Twojej wizyty w [Nazwa serwisu] został zmieniony.
Usługa: {{1}}
Nowy termin: {{2}}, godz. {{3}}
Numer rezerwacji: {{4}}
W razie pytań prosimy o kontakt telefoniczny.
```
**anulowanie_wizyty** — `{{1}}` data, `{{2}}` godzina, `{{3}}` nr rezerwacji
```
Twoja wizyta w [Nazwa serwisu] zaplanowana na {{1}}, godz. {{2}} (numer rezerwacji {{3}}) została odwołana. Zapraszamy do ponownej rezerwacji na naszej stronie.
```
Przykładowe wartości do zgłoszenia: `Wymiana opon (komplet)`, `poniedziałek, 12 października`, `09:00`, `WNKS7SPG`.

## Google Calendar
1. Google Cloud: projekt → włącz **Google Calendar API** → konto serwisowe → klucz JSON
   (`GOOGLE_SERVICE_ACCOUNT_KEY_FILE`, plik poza repozytorium, uprawnienia 600).
2. W Kalendarzu Google firmy: Ustawienia kalendarza → Udostępnij → e-mail konta serwisowego →
   „Wprowadzanie zmian w wydarzeniach”. Identyfikator kalendarza → `GOOGLE_CALENDAR_ID`.
3. `GOOGLE_CALENDAR_MODE=api`. Domyślnie bez imienia i telefonu klienta w eventach
   (`GOOGLE_CALENDAR_INCLUDE_PII=true`, jeśli właściciel ich potrzebuje — wtedy Google jest
   podmiotem przetwarzającym dane osobowe; uwzględnij to w rejestrze czynności przetwarzania).

## Monitoring
`GET /api/admin/system/health` — zaległe i nieudane wysyłki (z kodami błędów), stan synchronizacji kalendarza.
