import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

const base = 'inline-flex min-h-[2.75rem] items-center justify-center gap-2 rounded-lg px-4 font-semibold disabled:cursor-not-allowed disabled:opacity-50';

export function Btn({ variant = 'primary', busy, className = '', children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; busy?: boolean;
}) {
  const v = {
    primary: 'bg-signal text-ink active:bg-signal-deep',
    secondary: 'border-2 border-line bg-paper text-ink active:bg-concrete',
    danger: 'bg-danger text-white active:brightness-90',
    ghost: 'text-ink underline decoration-signal decoration-[3px] underline-offset-4 px-1',
  }[variant];
  return (
    <button {...rest} disabled={rest.disabled || busy} aria-busy={busy || undefined} className={`${base} ${v} ${className}`}>
      {busy && <span className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden="true" />}
      {children}
    </button>
  );
}

export function SelectField({ label, error, children, className = '', ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { label: string; error?: string; children: ReactNode }) {
  const id = useId();
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1 block text-[0.95rem] font-semibold">{label}</label>
      <select id={id} aria-invalid={error ? true : undefined} {...rest}
        className={`min-h-[2.75rem] w-full rounded-lg border-2 bg-paper px-3 ${error ? 'border-danger' : 'border-line'}`}>
        {children}
      </select>
      {error && <p className="mt-1 text-[0.92rem] font-medium text-danger">{error}</p>}
    </div>
  );
}

export function TextArea({ label, hint, className = '', ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; hint?: string }) {
  const id = useId();
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1 block text-[0.95rem] font-semibold">{label}</label>
      {hint && <p className="mb-1 text-[0.88rem] text-muted">{hint}</p>}
      <textarea id={id} rows={3} {...rest} className="w-full rounded-lg border-2 border-line bg-paper px-3 py-2 focus-within:border-ink" />
    </div>
  );
}

export function Input({ label, error, hint, className = '', ...rest }: React.InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string; hint?: string }) {
  const id = useId();
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1 block text-[0.95rem] font-semibold">{label}</label>
      {hint && <p className="mb-1 text-[0.88rem] text-muted">{hint}</p>}
      <input id={id} aria-invalid={error ? true : undefined} {...rest}
        className={`min-h-[2.75rem] w-full rounded-lg border-2 bg-paper px-3 ${error ? 'border-danger' : 'border-line focus:border-ink'}`} />
      {error && <p className="mt-1 text-[0.92rem] font-medium text-danger">{error}</p>}
    </div>
  );
}

export function Toggle({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  const id = useId();
  return (
    <label htmlFor={id} className="flex cursor-pointer items-start gap-2.5 py-1">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 size-5 shrink-0 accent-ink" />
      <span className="text-[0.95rem] leading-snug">{children}</span>
    </label>
  );
}

/**
 * Panel boczny (desktop) / pełny ekran (telefon). Esc zamyka, fokus wraca na element, który go otworzył.
 */
export function Drawer({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('h2')?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; opener?.focus?.(); };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-ink/40" onClick={onClose} aria-hidden="true" />
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title}
        className="relative flex h-full w-full flex-col bg-concrete shadow-2xl sm:max-w-[30rem]">
        <div className="flex items-center justify-between gap-3 bg-asphalt px-5 py-3.5 text-white">
          <h2 tabIndex={-1} className="font-display text-[1.6rem] font-bold leading-tight">{title}</h2>
          <button onClick={onClose} className="rounded-lg px-2 py-1 text-[1.6rem] leading-none text-[#c3c8cc]" aria-label="Zamknij">×</button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-5">{children}</div>
        {footer && <div className="border-t border-line bg-paper px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">{footer}</div>}
      </div>
    </div>
  );
}

export function ErrorBox({ children }: { children: ReactNode }) {
  return <div role="alert" className="rounded-lg border-l-[5px] border-danger bg-[#fdecea] px-4 py-3 text-[0.95rem] text-[#7a1a12]">{children}</div>;
}
export function InfoBox({ children }: { children: ReactNode }) {
  return <div role="status" className="rounded-lg border-l-[5px] border-signal bg-paper px-4 py-3 text-[0.95rem]">{children}</div>;
}
