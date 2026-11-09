import { useEffect, useRef, type ReactNode } from 'react';
import type { PublicInfo } from '../types';

export const STEP_NAMES = ['Usługa', 'Termin', 'Twoje dane'] as const;

/** Wspólny układ: nagłówek serwisu, postęp, tytuł kroku, treść i przyklejony do dołu pasek akcji. */
export function Shell({ info, step, title, children, footer }: {
  info: PublicInfo | undefined;
  step: number | null; // 1..3, null = ekran potwierdzenia
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  // po zmianie kroku przenieś fokus na tytuł — czytnik ekranu ogłosi nowy ekran
  useEffect(() => { headingRef.current?.focus(); }, [step, title]);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="bg-asphalt text-white">
        <div className="mx-auto flex max-w-xl items-center justify-between gap-4 px-4 py-3.5">
          <div className="min-w-0">
            <p className="truncate font-display text-[1.55rem] font-bold leading-tight">{info?.businessName ?? '\u00a0'}</p>
            {info?.address && <p className="truncate text-[0.9rem] text-[#c3c8cc]">{info.address}</p>}
          </div>
          {info?.phone && (
            <a href={`tel:${info.phone.replace(/\s/g, '')}`} className="shrink-0 rounded-lg border-2 border-asphalt-2 px-3 py-1.5 font-semibold text-signal">
              Zadzwoń
            </a>
          )}
        </div>
      </header>

      <main className="mx-auto w-full max-w-xl flex-1 px-4 pt-5 pb-8">
        {step !== null && (
          <div className="mb-4">
            <div className="flex gap-1.5" aria-hidden="true">
              {STEP_NAMES.map((_, i) => (
                <span key={i} className={`h-1.5 flex-1 rounded-full ${i < step ? 'bg-signal' : 'bg-line'}`} />
              ))}
            </div>
            <p className="mt-2 text-[0.92rem] font-medium text-muted">Krok {step} z {STEP_NAMES.length}</p>
          </div>
        )}
        <h1 ref={headingRef} tabIndex={-1} className="mb-5 font-display text-[2.1rem] font-bold leading-[1.05] outline-none">
          {title}
        </h1>
        {children}
      </main>

      {footer && (
        <div className="sticky bottom-0 border-t border-line bg-paper/95 backdrop-blur">
          <div className="mx-auto max-w-xl px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">{footer}</div>
        </div>
      )}
    </div>
  );
}
