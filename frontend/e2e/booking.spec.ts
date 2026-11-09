import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

let phoneSeq = 0;
// unikalny numer komórkowy na test — limity rezerwacji liczone są na numer
// prefiks 600 = sieć komórkowa (np. 62x to numery stacjonarne — backend je odrzuci, bo wysyłamy SMS/WhatsApp)
const nextPhone = () => `600${String((Date.now() + ++phoneSeq * 7919) % 1e6).padStart(6, '0')}`;

async function chooseServiceAndFirstFreeSlot(page: Page, service = 'Wymiana opon (komplet)') {
  await page.goto('/');
  await page.getByRole('button', { name: new RegExp(service.replace(/[()]/g, '\\$&')) }).click();
  await expect(page.getByRole('heading', { name: 'Wybierz termin' })).toBeVisible();
  const slot = page.getByRole('button', { name: /^\d\d:\d\d$/ }).first();
  const time = (await slot.textContent())!;
  await slot.click();
  return time;
}

async function fillDetails(page: Page, phone: string) {
  await page.getByLabel('Imię i nazwisko').fill('Anna Kowalska');
  await page.getByLabel('Telefon komórkowy').fill(phone);
  await page.getByLabel('Numer rejestracyjny').fill('wx 4521k');
  await page.getByLabel('Marka').fill('Skoda');
  await page.getByLabel('Model', { exact: true }).fill('Fabia');
  await page.getByRole('checkbox', { name: /Akceptuję regulamin/ }).check();
}

test('pełna rezerwacja na telefonie', async ({ page }) => {
  await chooseServiceAndFirstFreeSlot(page);
  await page.getByRole('button', { name: /^Dalej:/ }).click();
  await expect(page.getByRole('heading', { name: 'Twoje dane' })).toBeFocused(); // czytnik ekranu ogłasza nowy krok

  await page.getByLabel('Numer rejestracyjny').pressSequentially('wx4521k');
  await expect(page.getByText('WX 4521K', { exact: true })).toBeVisible(); // podgląd tablicy na żywo

  await page.getByRole('button', { name: 'Zarezerwuj wizytę' }).click();
  await expect(page.getByText('Podaj imię i nazwisko.')).toBeVisible();
  await expect(page.getByLabel('Imię i nazwisko')).toBeFocused(); // fokus na pierwszym błędnym polu

  await fillDetails(page, nextPhone());
  await page.getByRole('checkbox', { name: /WhatsApp/ }).check();
  await page.getByRole('button', { name: 'Zarezerwuj wizytę' }).click();

  await expect(page.getByRole('heading', { name: 'Wizyta zarezerwowana' })).toBeVisible();
  await expect(page.getByText(/^[2-9A-HJ-NP-Z]{8}$/)).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Dodaj do kalendarza' }).click();
  expect((await download).suggestedFilename()).toMatch(/^wizyta-[A-Z0-9]{8}\.ics$/);
});

test('termin zajęty w międzyczasie → powrót do wyboru godziny, dane zachowane', async ({ page, request }) => {
  const time = await chooseServiceAndFirstFreeSlot(page);
  await page.getByRole('button', { name: /^Dalej:/ }).click();
  await fillDetails(page, nextPhone());

  // ktoś inny zajmuje wszystkie wolne stanowiska na ten termin, zanim klient kliknie "Zarezerwuj"
  await page.goBack();
  const startsAt = await page.getByRole('button', { name: time, exact: true }).getAttribute('data-starts-at');
  await page.goForward();
  let taken = 0;
  for (let i = 0; i < 5; i++) {
    const res = await request.post('/api/public/bookings', {
      headers: { 'Idempotency-Key': randomUUID() },
      data: { serviceId: 1, startsAt, fullName: 'Ktoś Inny', phone: nextPhone(), acceptTerms: true,
        vehicle: { make: 'Fiat', model: 'Panda', registrationNumber: `KR${1000 + i}` } },
    });
    if (res.status() === 409) break;
    expect(res.status()).toBe(201);
    taken++;
  }
  expect(taken).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Zarezerwuj wizytę' }).click();
  await expect(page.getByRole('heading', { name: 'Wybierz termin' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText(`Godzina ${time} została właśnie zajęta`);
  await expect(page.getByRole('button', { name: time, exact: true })).toHaveCount(0); // zniknęła z listy
  await expect(page.getByRole('button', { name: 'Wybierz godzinę' })).toBeDisabled();

  await page.getByRole('button', { name: /^\d\d:\d\d$/ }).first().click();
  await page.getByRole('button', { name: /^Dalej:/ }).click();
  await expect(page.getByLabel('Imię i nazwisko')).toHaveValue('Anna Kowalska'); // nic nie trzeba wpisywać ponownie
  await page.getByRole('checkbox', { name: /Akceptuję regulamin/ }).check({ force: true });
  await page.getByRole('button', { name: 'Zarezerwuj wizytę' }).click();
  await expect(page.getByRole('heading', { name: 'Wizyta zarezerwowana' })).toBeVisible();
});

test('przycisk "wstecz" telefonu cofa o krok, a nie zamyka strony', async ({ page }) => {
  const time = await chooseServiceAndFirstFreeSlot(page);
  await page.getByRole('button', { name: /^Dalej:/ }).click();
  await expect(page.getByRole('heading', { name: 'Twoje dane' })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Wybierz termin' })).toBeVisible();
  await expect(page.getByRole('button', { name: time, exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Co robimy?' })).toBeVisible();
});

test('błąd z backendu trafia pod właściwe pole (numer stacjonarny zamiast komórki)', async ({ page }) => {
  await chooseServiceAndFirstFreeSlot(page);
  await page.getByRole('button', { name: /^Dalej:/ }).click();
  await fillDetails(page, '22 123 45 67');
  await page.getByRole('button', { name: 'Zarezerwuj wizytę' }).click();
  await expect(page.getByText('Podaj numer telefonu komórkowego (potrzebny do SMS)')).toBeVisible();
  await expect(page.getByLabel('Telefon komórkowy')).toBeFocused();
});

test('zerwane połączenie → ponowienie z tym samym kluczem idempotencji (bez podwójnej rezerwacji)', async ({ page }) => {
  await chooseServiceAndFirstFreeSlot(page);
  await page.getByRole('button', { name: /^Dalej:/ }).click();
  await fillDetails(page, nextPhone());

  const keys: string[] = [];
  let first = true;
  await page.route('**/api/public/bookings', async (route) => {
    keys.push(route.request().headers()['idempotency-key']!);
    if (first) {
      first = false;
      // żądanie DOTARŁO do serwera (rezerwacja zapisana), ale odpowiedź zginęła po drodze
      await route.fetch();
      await route.abort('connectionreset');
      return;
    }
    await route.continue();
  });

  await page.getByRole('button', { name: 'Zarezerwuj wizytę' }).click();
  await expect(page.getByRole('alert')).toContainText('Brak połączenia');
  await page.getByRole('button', { name: 'Zarezerwuj wizytę' }).click();
  await expect(page.getByRole('heading', { name: 'Wizyta zarezerwowana' })).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]); // serwer rozpoznał powtórkę i zwrócił tę samą wizytę (200), zamiast tworzyć drugą
});
