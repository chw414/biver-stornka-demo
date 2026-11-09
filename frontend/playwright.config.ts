import { defineConfig, devices } from '@playwright/test';

/**
 * E2E na działającym stosie (API + baza testowa + `vite preview`), bez mocków.
 *   npx playwright install chromium     # jednorazowo
 *   npm run test:e2e
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  fullyParallel: false, // testy dzielą bazę i rezerwują terminy
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:4173',
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
});
