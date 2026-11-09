import { expect, test, type Page } from '@playwright/test';

/**
 * Panel admina na danych z `npm run seed:demo` (backend). Testy zmieniają dane — uruchamiaj na bazie testowej.
 */
// w produkcji ciasteczka mają prefiks __Host- (E2E_COOKIE_PREFIX=__Host- przy testach na NODE_ENV=production)
const ACCESS_COOKIE = (process.env.E2E_COOKIE_PREFIX ?? '') + 'sa_at';
const OWNER = { email: 'jan@oponymokotow.pl', password: process.env.SEED_OWNER_PASSWORD ?? 'Haslo-Wlasciciela-2026' };
const STAFF = { email: 'marek@oponymokotow.pl', password: process.env.SEED_STAFF_PASSWORD ?? 'Haslo-Pracownika-2026' };

test.use({ viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false });

/** Najbliższy dzień roboczy co najmniej 6 dni od dziś (strefa serwisu). */
function workday(): string {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Warsaw' }));
  d.setDate(d.getDate() + 6); // za dniami z seed:demo (wczoraj…+4)
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const DAY = workday();

async function login(page: Page, who = OWNER) {
  await page.goto('/admin/');
  await page.getByLabel('E-mail').fill(who.email);
  await page.getByLabel('Hasło').fill(who.password);
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await expect(page.getByRole('link', { name: 'Kalendarz' })).toBeVisible();
}
const openDay = (page: Page, day = DAY) => page.goto(`/admin/#/kalendarz?d=${day}&v=day`);

async function addAppointment(page: Page, station: string, time: string, phone: string, plate: string) {
  await page.getByRole('button', { name: `Dodaj wizytę: ${station}, ${time}` }).click();
  const drawer = page.getByRole('dialog', { name: 'Nowa wizyta' });
  await drawer.getByLabel('Telefon').fill(phone);
  await drawer.getByLabel('Imię i nazwisko').fill('Robert Testowy');
  await drawer.getByLabel('Numer rejestracyjny').fill(plate);
  await drawer.getByLabel('Marka').fill('Mazda');
  await drawer.getByLabel('Model').fill('3');
  await page.getByRole('button', { name: 'Dodaj wizytę', exact: true }).click();
  await expect(page.getByRole('dialog', { name: /^\d\d:\d\d–\d\d:\d\d$/ })).toBeVisible(); // otwiera się nowa wizyta
}

test('logowanie: złe hasło, potem poprawne', async ({ page }) => {
  await page.goto('/admin/');
  await page.getByLabel('E-mail').fill(OWNER.email);
  await page.getByLabel('Hasło').fill('zle-haslo-123');
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await expect(page.getByRole('alert')).toHaveText('Nieprawidłowy e-mail lub hasło.');
  await expect(page.getByLabel('Hasło')).toHaveValue('');
  await login(page);
});

test('wizyta telefoniczna z kliknięcia w kalendarz → przesunięcie → konflikt → odwołanie', async ({ page }) => {
  await login(page);
  await openDay(page);
  await addAppointment(page, 'Stanowisko 1', '15:00', '600 300 401', 'WB 1111A');

  const drawer = page.getByRole('dialog');
  await expect(drawer).toContainText('WB1111A');
  await expect(drawer).toContainText('Stanowisko 1');
  await expect(drawer).toContainText('Potwierdzenie'); // zaplanowane powiadomienie
  await page.keyboard.press('Escape');
  const card = page.getByRole('button', { name: /^15:00, Wymiana opon \(komplet\), WB1111A/ });
  await expect(card).toBeVisible();

  // przesunięcie na 15:30
  await card.click();
  await page.getByRole('button', { name: 'Przesuń', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Godzina', { exact: true }).selectOption('15:30');
  await page.getByRole('button', { name: 'Przesuń wizytę' }).click();
  await expect(page.getByRole('dialog', { name: '15:30–15:45' })).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('Zmiana terminu'); // wiadomość do klienta o nowym terminie

  // zajmij Stanowisko 2 o 16:00, potem spróbuj przesunąć tam wizytę WB1111A na wskazane stanowisko 2
  await page.keyboard.press('Escape');
  await addAppointment(page, 'Stanowisko 2', '16:00', '600 300 402', 'WB 2222B');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^15:30, .*WB1111A/ }).click();
  await page.getByRole('button', { name: 'Przesuń', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Godzina', { exact: true }).selectOption('16:00');
  await page.getByRole('dialog').getByLabel('Stanowisko', { exact: true }).selectOption({ label: 'Stanowisko 2' });
  await page.getByRole('button', { name: 'Przesuń wizytę' }).click();
  await expect(page.getByRole('alert')).toContainText('To stanowisko jest w tym czasie zajęte');

  // odwołanie
  await page.getByRole('button', { name: 'Anuluj' }).click();
  await page.getByRole('button', { name: 'Odwołaj', exact: true }).click();
  await page.getByLabel('Powód (opcjonalnie)').fill('Klient zadzwonił');
  await page.getByRole('button', { name: 'Odwołaj wizytę' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /WB1111A/ })).toHaveCount(0);
});

test('poza godzinami pracy wymaga świadomego potwierdzenia', async ({ page }) => {
  await login(page);
  await openDay(page);
  await page.getByRole('button', { name: 'Nowa wizyta' }).click();
  const d = page.getByRole('dialog', { name: 'Nowa wizyta' });
  await d.getByLabel('Godzina', { exact: true }).selectOption('19:00');
  await d.getByLabel('Telefon').fill('600 300 403');
  await d.getByLabel('Imię i nazwisko').fill('Wieczorny Klient');
  await d.getByLabel('Numer rejestracyjny').fill('WB3333C');
  await d.getByLabel('Marka').fill('Fiat');
  await d.getByLabel('Model').fill('Tipo');
  await page.getByRole('button', { name: 'Dodaj wizytę', exact: true }).click();
  await expect(page.getByText('Ten termin jest poza godzinami pracy serwisu.')).toBeVisible();
  await page.getByRole('button', { name: 'Dodaj mimo to' }).click();
  await expect(page.getByRole('dialog', { name: '19:00–19:15' })).toBeVisible();
});

test('równoczesna edycja w dwóch kartach → komunikat i aktualne dane zamiast nadpisania', async ({ page, browser }) => {
  await login(page);
  await openDay(page);
  await addAppointment(page, 'Stanowisko 1', '14:00', '600 300 404', 'WB 4444D');

  // druga osoba (pracownik, osobna sesja) zmienia tę samą wizytę
  const other = await (await browser.newContext({ baseURL: page.url().split('/admin')[0] })).newPage();
  await login(other, STAFF);
  await openDay(other);
  await other.getByRole('button', { name: /^14:00, .*WB4444D/ }).click();
  await other.getByLabel('Notatka warsztatu').fill('Klient prosi o kontrolę ciśnienia');
  await other.getByRole('button', { name: 'Zapisz notatkę' }).click();
  await expect(other.getByRole('button', { name: 'Zapisz notatkę' })).toHaveCount(0);

  // pierwsza karta ma starą wersję wizyty
  await page.getByLabel('Notatka warsztatu').fill('Inna notatka');
  await page.getByRole('button', { name: 'Zapisz notatkę' }).click();
  await expect(page.getByRole('alert')).toContainText('Ktoś właśnie zmienił tę wizytę');
  await expect(page.getByLabel('Notatka warsztatu')).toHaveValue('Klient prosi o kontrolę ciśnienia');
});

test('klienci: wyszukiwanie po fragmencie tablicy, edycja rozmiaru opon', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'Klienci' }).click();
  await page.getByPlaceholder('Nazwisko, telefon albo numer rejestracyjny').fill('wx 993');
  await expect(page.getByText('Znaleziono: 1')).toBeVisible();
  await page.getByRole('link', { name: /Andrzej Kamiński/ }).click();
  await page.getByRole('button', { name: 'Edytuj' }).click();
  await page.getByLabel('Rozmiar opon').fill('205/55 r16');
  await page.getByRole('button', { name: 'Zapisz', exact: true }).click();
  await expect(page.getByText('205/55 R16')).toBeVisible(); // backend normalizuje zapis
});

test('uprawnienia: pracownik nie widzi usuwania danych (RODO), właściciel widzi', async ({ page, browser }) => {
  await login(page, STAFF);
  await page.goto('/admin/#/klienci?q=Kowalska');
  await page.getByRole('link', { name: /Anna Kowalska/ }).click();
  await expect(page.getByRole('heading', { name: 'Historia wizyt' })).toBeVisible();
  await expect(page.getByText('Usunięcie danych (RODO)')).toHaveCount(0);

  const owner = await (await browser.newContext({ baseURL: page.url().split('/admin')[0] })).newPage();
  await login(owner);
  await owner.goto('/admin/#/klienci?q=Kowalska');
  await owner.getByRole('link', { name: /Anna Kowalska/ }).click();
  await expect(owner.getByText('Usunięcie danych (RODO)')).toBeVisible();
});

test('wygasły access token → panel sam odświeża sesję; po wylogowaniu dane znikają', async ({ page, context }) => {
  await login(page);
  // symulacja wygaśnięcia 15-minutowego access tokenu: usuwamy go (refresh token zostaje)
  await context.clearCookies({ name: ACCESS_COOKIE });
  await page.getByRole('link', { name: 'Klienci' }).click();
  await expect(page.getByText(/Znaleziono: \d+/)).toBeVisible();
  expect((await context.cookies()).some((c) => c.name === ACCESS_COOKIE)).toBe(true); // nowy token wydany

  await page.getByRole('button', { name: 'Wyloguj' }).click();
  await expect(page.getByRole('heading', { name: 'Panel serwisu' })).toBeVisible();
  await page.goto('/admin/#/klienci');
  await expect(page.getByRole('button', { name: 'Zaloguj się' })).toBeVisible();
  await expect(page.getByText('Anna Kowalska')).toHaveCount(0);
});

test('blokada stanowiska pojawia się w kalendarzu i znika z rezerwacji online', async ({ page, request }) => {
  await login(page);
  await openDay(page);
  const before = (await (await request.get(`/api/public/availability?serviceId=1&date=${DAY}`)).json()).slots.length;
  await page.getByRole('button', { name: 'Zablokuj' }).click();
  const d = page.getByRole('dialog', { name: 'Blokada stanowiska' });
  await d.getByLabel('Od').selectOption('08:00');
  await d.getByLabel('Do').selectOption('10:00');
  await d.getByLabel('Powód (opcjonalnie)').fill('Szkolenie');
  await d.getByRole('button', { name: 'Zablokuj' }).click();
  // zablokowano — ewentualne kolidujące wizyty są wypisane jako ostrzeżenie do przeniesienia
  await expect(d.getByText(/^Zablokowano/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByText('Zablokowane: Szkolenie').first()).toBeVisible();
  const after = (await (await request.get(`/api/public/availability?serviceId=1&date=${DAY}`)).json()).slots.length;
  expect(after).toBe(before - 8); // 8 kwadransów 8:00–10:00 zniknęło z rezerwacji online
});
