import { normalizePlate } from '../validation';

/**
 * Wyróżnik serii polskich tablic: 2 litery (miasto) lub 3 litery (powiat), reszta po spacji.
 * To tylko wyróżnik do wyświetlania — w bazie numer jest bez spacji.
 */
export function formatPlate(raw: string): string {
  const p = normalizePlate(raw);
  const letters = p.match(/^[A-Z]{1,3}/)?.[0].length ?? 0;
  const cut = letters >= 3 ? 3 : 2;
  return p.length > cut ? `${p.slice(0, cut)} ${p.slice(cut)}` : p;
}

function EuStars() {
  // 12 gwiazd na okręgu — jak na tablicy UE
  const star = 'M0,-1 L0.29,-0.4 L0.95,-0.31 L0.47,0.15 L0.59,0.81 L0,0.5 L-0.59,0.81 L-0.47,0.15 L-0.95,-0.31 L-0.29,-0.4 Z';
  return (
    <svg viewBox="-12 -12 24 24" className="w-full" aria-hidden="true">
      {Array.from({ length: 12 }, (_, i) => {
        const a = (i / 12) * Math.PI * 2;
        return <path key={i} d={star} fill="#FFDD00" transform={`translate(${Math.sin(a) * 8} ${-Math.cos(a) * 8}) scale(1.6)`} />;
      })}
    </svg>
  );
}

/** Podgląd tablicy rejestracyjnej aktualizowany na żywo podczas wpisywania. */
export function PlatePreview({ value, invalid }: { value: string; invalid?: boolean }) {
  const text = formatPlate(value);
  const empty = text.length === 0;
  return (
    <div
      aria-hidden="true"
      className={[
        'flex h-[3.75rem] w-full max-w-[17.5rem] overflow-hidden rounded-[7px] border-[3px] bg-white select-none',
        invalid ? 'border-danger' : 'border-ink',
        'shadow-[inset_0_0_0_1.5px_#fff,inset_0_0_0_3px_#1b1e21]',
      ].join(' ')}
    >
      <div className="flex w-[2.6rem] shrink-0 flex-col items-center justify-between bg-eu px-1 pt-1.5 pb-1">
        <EuStars />
        <span className="font-display text-[0.95rem] font-bold leading-none tracking-wide text-white">PL</span>
      </div>
      <div className="flex flex-1 items-center justify-center px-2">
        <span
          className={[
            'font-display whitespace-nowrap text-[2.15rem] font-bold leading-none tracking-[0.06em]',
            empty ? 'text-line' : 'text-ink',
          ].join(' ')}
        >
          {empty ? 'WX 12345' : text}
        </span>
      </div>
    </div>
  );
}
