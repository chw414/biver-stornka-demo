import { useState } from 'react';
import { ApiError, api } from '../../shared/api';
import { setCsrfToken } from '../api';
import type { Admin } from '../types';
import { Btn, ErrorBox, Input } from '../components/controls';

export function LoginPage({ onLoggedIn, reason }: { onLoggedIn: (a: Admin) => void; reason: string | null }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await api<{ admin: Admin; csrfToken: string }>('/admin/auth/login', { method: 'POST', json: { email, password } });
      setCsrfToken(r.csrfToken);
      onLoggedIn(r.admin);
    } catch (err) {
      setError(err instanceof ApiError
        ? (err.status === 429 ? 'Zbyt wiele prób logowania. Odczekaj kilka minut.' : err.status === 401 ? 'Nieprawidłowy e-mail lub hasło.' : err.message)
        : 'Nie udało się zalogować.');
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-asphalt px-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-xl bg-concrete p-6">
        <h1 className="font-display text-[2rem] font-bold leading-tight">Panel serwisu</h1>
        {reason && !error && <p className="text-muted">{reason}</p>}
        {error && <ErrorBox>{error}</ErrorBox>}
        <Input label="E-mail" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        <Input label="Hasło" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        <Btn type="submit" busy={busy} className="w-full">Zaloguj się</Btn>
      </form>
    </div>
  );
}
