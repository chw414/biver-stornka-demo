import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { adminApi } from '../api';
import { navigate, type Route } from '../router';
import { fmtDate, fmtDateTime, fmtPhone } from '../time';
import type { CustomerRow } from '../types';
import { Btn, ErrorBox } from '../components/controls';

const PAGE = 25;

export function CustomersPage({ route }: { route: Route }) {
  const q = route.params.get('q') ?? '';
  const [input, setInput] = useState(q);
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => {
    const t = setTimeout(() => { if (input !== q) navigate('/klienci', input ? { q: input } : undefined, true); setLimit(PAGE); }, 300);
    return () => clearTimeout(t);
  }, [input, q]);

  const list = useQuery({
    queryKey: ['customers-list', q, limit],
    queryFn: () => adminApi<{ total: number; customers: CustomerRow[] }>(`/customers?${new URLSearchParams({ ...(q ? { q } : {}), limit: String(Math.min(limit, 100)) })}`),
    placeholderData: keepPreviousData,
  });

  return (
    <div className="mx-auto max-w-5xl px-3 py-5 sm:px-5">
      <h1 className="mb-4 font-display text-[2rem] font-bold">Klienci</h1>
      <label htmlFor="cq" className="sr-only">Szukaj klienta</label>
      <input id="cq" type="search" value={input} onChange={(e) => setInput(e.target.value)} autoFocus
        placeholder="Nazwisko, telefon albo numer rejestracyjny"
        className="mb-4 min-h-[3rem] w-full rounded-lg border-2 border-line bg-paper px-4 text-[1.05rem] focus:border-ink" />
      {list.isError && <ErrorBox>{list.error.message}</ErrorBox>}
      {list.data && (
        <>
          <p className="mb-2 text-[0.92rem] text-muted" aria-live="polite">
            {list.data.total === 0 ? (q ? 'Nikogo nie znaleziono. Sprawdź pisownię albo szukaj po numerze telefonu.' : 'Baza klientów jest pusta — pojawią się tu po pierwszych rezerwacjach.') : `Znaleziono: ${list.data.total}`}
          </p>
          <ul className="divide-y divide-line overflow-hidden rounded-xl bg-paper">
            {list.data.customers.map((c) => (
              <li key={c.id}>
                <a href={`#/klienci/${c.id}`} className="grid gap-x-4 gap-y-0.5 px-4 py-3 hover:bg-[#fff6d6] sm:grid-cols-[1.4fr_1fr_1fr_1fr]">
                  <span><span className="font-semibold">{c.fullName}</span><span className="block tabular-nums text-muted">{fmtPhone(c.phone)}</span></span>
                  <span className="font-display text-[1.05rem] font-bold tracking-wide">{c.plates.join(', ') || '—'}</span>
                  <span className="text-[0.92rem] text-muted">{c.completedVisits} {c.completedVisits === 1 ? 'wizyta' : 'wizyt'}{c.noShows > 0 && <span className="text-danger">, {c.noShows}× nie przyjechał</span>}
                    {c.lastVisitAt && <span className="block">ostatnio {fmtDate(c.lastVisitAt)}</span>}</span>
                  <span className="text-[0.92rem]">{c.nextVisitAt ? <>najbliższa: <span className="font-semibold">{fmtDateTime(c.nextVisitAt)}</span></> : ''}</span>
                </a>
              </li>
            ))}
          </ul>
          {list.data.total > list.data.customers.length && limit < 100 && (
            <div className="mt-4 text-center"><Btn variant="secondary" busy={list.isFetching} onClick={() => setLimit((l) => l + PAGE)}>Pokaż więcej</Btn></div>
          )}
        </>
      )}
    </div>
  );
}
