import { formatDuration, formatPrice } from '../format';
import type { PriceInfo, Service } from '../types';
import { Alert } from '../../shared/ui';

const Chevron = ({ className = '' }: { className?: string }) => (
  <svg viewBox="0 0 24 24" className={`size-6 shrink-0 text-muted ${className}`} aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

/** Kolejność grup = kolejność pierwszego wystąpienia z serwera; usługi bez kategorii trafiają do jednej płaskiej listy. */
function groupByCategory(services: Service[]): [string | null, Service[]][] {
  const groups = new Map<string | null, Service[]>();
  for (const s of services) groups.set(s.category, [...(groups.get(s.category) ?? []), s]);
  return [...groups.entries()];
}

export function ServiceStep({ services, loading, error, selectedId, priceInfo, onSelect, onRetry }: {
  services: Service[] | undefined; loading: boolean; error: Error | null;
  selectedId: number | null; priceInfo: PriceInfo | null; onSelect: (s: Service) => void; onRetry: () => void;
}) {
  if (error) {
    return (
      <Alert>
        Nie udało się wczytać listy usług. {error.message}{' '}
        <button className="font-semibold underline" onClick={onRetry}>Spróbuj ponownie</button>
      </Alert>
    );
  }
  if (loading || !services) {
    return (
      <ul className="divide-y divide-line overflow-hidden rounded-xl bg-paper" aria-busy="true" aria-label="Wczytywanie usług">
        {[0, 1, 2].map((i) => <li key={i} className="h-[4.75rem] animate-pulse bg-paper" />)}
      </ul>
    );
  }
  if (services.length === 0) {
    return <Alert tone="info">Rezerwacja online jest chwilowo wyłączona. Zadzwoń, a umówimy termin.</Alert>;
  }

  const row = (s: Service, label: string) => (
    <li key={s.id}>
      <button
        type="button"
        onClick={() => onSelect(s)}
        aria-current={selectedId === s.id ? 'true' : undefined}
        className="flex w-full items-center gap-4 px-4 py-4 text-left active:bg-concrete"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-[1.15rem] font-semibold leading-snug">{label}</span>
          <span className="mt-0.5 block text-[0.95rem] text-muted">
            {formatDuration(s.durationMinutes)}
            {s.priceFromPln !== null && `, od ${formatPrice(s.priceFromPln)}`}
          </span>
          {s.description && <span className="mt-1 block text-[0.95rem] text-muted">{s.description}</span>}
        </span>
        <Chevron />
      </button>
    </li>
  );

  const groups = groupByCategory(services);
  const grouped = groups.some(([category]) => category !== null);

  return (
    <>
      {priceInfo?.note && <p className="mb-3 text-[0.95rem] text-muted">{priceInfo.note}</p>}

      {!grouped && <ul className="divide-y divide-line overflow-hidden rounded-xl bg-paper">{services.map((s) => row(s, s.name))}</ul>}

      {grouped && (
        <div className="space-y-3">
          {groups.map(([category, list]) => {
            const cheapest = Math.min(...list.map((s) => s.priceFromPln ?? Infinity));
            const note = category ? priceInfo?.groupNotes[category] : undefined;
            const open = list.some((s) => s.id === selectedId);
            return (
              <details key={category ?? 'inne'} open={open} className="group overflow-hidden rounded-xl bg-paper">
                <summary className="flex cursor-pointer list-none items-center gap-4 px-4 py-4 [&::-webkit-details-marker]:hidden">
                  <span className="min-w-0 flex-1">
                    <span className="block text-[1.2rem] font-semibold leading-snug">{category ?? 'Pozostałe'}</span>
                    <span className="mt-0.5 block text-[0.95rem] text-muted">
                      {list.length} {list.length === 1 ? 'wariant' : list.length < 5 ? 'warianty' : 'wariantów'}
                      {Number.isFinite(cheapest) && `, od ${formatPrice(cheapest)}`}
                    </span>
                  </span>
                  <Chevron className="transition-transform group-open:rotate-90" />
                </summary>
                {note && <p className="border-t border-line px-4 pt-3 text-[0.95rem] text-muted">{note}</p>}
                <ul className="mt-1 divide-y divide-line border-t border-line">
                  {list.map((s) => row(s, s.shortName ?? s.name))}
                </ul>
              </details>
            );
          })}
        </div>
      )}

      {priceInfo && priceInfo.items.length > 0 && (
        <details className="group mt-3 overflow-hidden rounded-xl bg-paper">
          <summary className="flex cursor-pointer list-none items-center gap-4 px-4 py-4 [&::-webkit-details-marker]:hidden">
            <span className="min-w-0 flex-1">
              <span className="block text-[1.2rem] font-semibold leading-snug">Dodatki i inne usługi</span>
              <span className="mt-0.5 block text-[0.95rem] text-muted">Czujniki, zawory, naprawa opony, przechowywanie…</span>
            </span>
            <Chevron className="transition-transform group-open:rotate-90" />
          </summary>
          <dl className="divide-y divide-line border-t border-line">
            {priceInfo.items.map((it) => (
              <div key={it.label} className="flex justify-between gap-4 px-4 py-3 text-[0.98rem]">
                <dt className="text-muted">{it.label}</dt>
                <dd className="text-right font-semibold">{it.price}</dd>
              </div>
            ))}
          </dl>
          <p className="border-t border-line px-4 py-3 text-[0.92rem] text-muted">Dodatki płacisz na miejscu — nie wybierasz ich przy rezerwacji.</p>
        </details>
      )}
    </>
  );
}
