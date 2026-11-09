import { hhmm } from '../time';
import { SelectField } from './controls';

export const TIME_OPTIONS = Array.from({ length: (22 - 6) * 4 }, (_, i) => hhmm(6 * 60 + i * 15));
export const DURATION_OPTIONS = Array.from({ length: 16 }, (_, i) => (i + 1) * 15);
export const durationLabel = (m: number) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`);

export function TimeSelect({ value, onChange, label = 'Godzina' }: { value: string; onChange: (v: string) => void; label?: string }) {
  return (
    <SelectField label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {TIME_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
    </SelectField>
  );
}
export function DurationSelect({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <SelectField label="Czas trwania" value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {DURATION_OPTIONS.map((m) => <option key={m} value={m}>{durationLabel(m)}</option>)}
    </SelectField>
  );
}
export function StationSelect({ value, onChange, stations, allowAuto = true, allLabel }: {
  value: string; onChange: (v: string) => void; stations: { id: number; name: string }[]; allowAuto?: boolean; allLabel?: string;
}) {
  return (
    <SelectField label="Stanowisko" value={value} onChange={(e) => onChange(e.target.value)}>
      {allowAuto && <option value="">Pierwsze wolne</option>}
      {allLabel && <option value="all">{allLabel}</option>}
      {stations.map((s) => <option key={s.id} value={String(s.id)}>{s.name}</option>)}
    </SelectField>
  );
}
