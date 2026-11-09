import { forwardRef, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';

export function PrimaryButton({ busy, children, className = '', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return (
    <button
      {...rest}
      aria-busy={busy || undefined}
      disabled={rest.disabled || busy}
      className={[
        'inline-flex min-h-[3.25rem] w-full items-center justify-center gap-2 rounded-lg bg-signal px-5',
        'font-display text-[1.3rem] font-bold text-ink',
        'active:bg-signal-deep disabled:cursor-not-allowed disabled:bg-line disabled:text-muted',
        className,
      ].join(' ')}
    >
      {busy && <span className="size-4 animate-spin rounded-full border-2 border-ink border-r-transparent" aria-hidden="true" />}
      {children}
    </button>
  );
}

export function TextButton({ children, className = '', ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...rest} className={`font-medium text-ink underline decoration-signal decoration-[3px] underline-offset-4 ${className}`}>
      {children}
    </button>
  );
}

export function Alert({ children, tone = 'error' }: { children: ReactNode; tone?: 'error' | 'info' }) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={[
        'rounded-lg border-l-[5px] px-4 py-3 text-[0.98rem]',
        tone === 'error' ? 'border-danger bg-[#fdecea] text-[#7a1a12]' : 'border-signal bg-paper text-ink',
      ].join(' ')}
    >
      {children}
    </div>
  );
}

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  error?: string;
  prefix?: string;
}

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field({ label, hint, error, prefix, className = '', ...rest }, ref) {
  const id = useId();
  const describedBy = [hint && `${id}-hint`, error && `${id}-err`].filter(Boolean).join(' ') || undefined;
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 block font-semibold">{label}</label>
      {hint && <p id={`${id}-hint`} className="mb-1.5 text-[0.92rem] text-muted">{hint}</p>}
      <div className={[
        'flex min-h-[3.25rem] items-stretch overflow-hidden rounded-lg border-2 bg-paper',
        error ? 'border-danger focus-within:shadow-[0_0_0_3px_rgba(180,35,24,0.25)]' : 'border-line focus-within:border-ink focus-within:shadow-[0_0_0_3px_rgba(245,197,24,0.55)]',
      ].join(' ')}>
        {prefix && <span className="flex items-center border-r-2 border-line bg-concrete px-3 font-medium text-muted">{prefix}</span>}
        <input
          ref={ref}
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className="w-full min-w-0 bg-transparent px-3.5 text-[1.0625rem] outline-none placeholder:text-[#9aa1a7] focus-visible:shadow-none focus-visible:outline-none"
          {...rest}
        />
      </div>
      {error && <p id={`${id}-err`} className="mt-1.5 text-[0.95rem] font-medium text-danger">{error}</p>}
    </div>
  );
});

export function Checkbox({ checked, onChange, error, children, inputRef }: {
  checked: boolean; onChange: (v: boolean) => void; error?: string; children: ReactNode; inputRef?: React.Ref<HTMLInputElement>;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="flex cursor-pointer gap-3 py-1">
        <input
          ref={inputRef}
          id={id}
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-err` : undefined}
          className="mt-0.5 size-6 shrink-0 cursor-pointer accent-ink"
        />
        <span className="text-[0.98rem] leading-snug">{children}</span>
      </label>
      {error && <p id={`${id}-err`} className="mt-1 pl-9 text-[0.95rem] font-medium text-danger">{error}</p>}
    </div>
  );
}
