import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../shared/api';
import { adminApi, setCsrfToken, setSessionLostHandler } from './api';
import { navigate, useRoute } from './router';
import type { Admin } from './types';
import { LoginPage } from './pages/LoginPage';
import { CalendarPage } from './pages/CalendarPage';
import { CustomersPage } from './pages/CustomersPage';
import { CustomerPage } from './pages/CustomerPage';
import { HealthPage } from './pages/HealthPage';

type Auth = { state: 'checking' } | { state: 'out'; reason: string | null } | { state: 'in'; admin: Admin };

const NAV = [
  { path: '/kalendarz', label: 'Kalendarz' },
  { path: '/klienci', label: 'Klienci' },
  { path: '/system', label: 'Powiadomienia' },
];

export function AdminApp() {
  const [auth, setAuth] = useState<Auth>({ state: 'checking' });
  const route = useRoute();
  const qc = useQueryClient();

  const lose = useCallback((reason: string | null) => { setCsrfToken(null); qc.clear(); setAuth({ state: 'out', reason }); }, [qc]);

  useEffect(() => {
    setSessionLostHandler(() => lose('Sesja wygasła. Zaloguj się ponownie.'));
    // po przeładowaniu strony: czy ciasteczka sesji są nadal ważne? (me → token CSRF do pamięci)
    adminApi<{ admin: Admin; csrfToken: string }>('/auth/me')
      .then((r) => { setCsrfToken(r.csrfToken); setAuth({ state: 'in', admin: r.admin }); })
      .catch(() => setAuth({ state: 'out', reason: null }));
  }, [lose]);

  async function logout() {
    await api('/admin/auth/logout', { method: 'POST' }).catch(() => undefined);
    lose(null);
  }

  if (auth.state === 'checking') return <div className="min-h-dvh bg-asphalt" aria-busy="true" />;
  if (auth.state === 'out') return <LoginPage reason={auth.reason} onLoggedIn={(admin) => setAuth({ state: 'in', admin })} />;

  const section = '/' + (route.path.split('/')[1] ?? '');
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 bg-asphalt text-white">
        <div className="mx-auto flex max-w-[90rem] items-center gap-2 px-3 sm:gap-6 sm:px-5">
          <span className="hidden py-3 font-display text-[1.4rem] font-bold sm:block">Panel serwisu</span>
          <nav className="flex flex-1 gap-1 overflow-x-auto" aria-label="Główna nawigacja">
            {NAV.map((n) => (
              <a key={n.path} href={`#${n.path}`} aria-current={section === n.path ? 'page' : undefined}
                className={`whitespace-nowrap border-b-[3px] px-2 py-3.5 font-semibold sm:px-3 ${section === n.path ? 'border-signal text-white' : 'border-transparent text-[#c3c8cc]'}`}>
                {n.label}
              </a>
            ))}
          </nav>
          <span className="hidden text-[0.9rem] text-[#c3c8cc] md:block">{auth.admin.fullName}</span>
          <button onClick={logout} className="whitespace-nowrap rounded-lg px-2 py-2 text-[0.95rem] font-semibold text-signal">Wyloguj</button>
        </div>
      </header>
      <main className="flex-1">
        {section === '/kalendarz' && <CalendarPage route={route} />}
        {route.path === '/klienci' && <CustomersPage route={route} />}
        {route.path.startsWith('/klienci/') && <CustomerPage id={route.path.split('/')[2]!} admin={auth.admin} />}
        {section === '/system' && <HealthPage />}
        {!['/kalendarz', '/klienci', '/system'].includes(section) && (() => { navigate('/kalendarz', undefined, true); return null; })()}
      </main>
    </div>
  );
}
