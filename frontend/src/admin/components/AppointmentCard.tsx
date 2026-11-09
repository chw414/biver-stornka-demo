import type { CalendarAppointment } from '../types';
import { fmtTime } from '../time';

const STYLE: Record<CalendarAppointment['status'], string> = {
  confirmed: 'bg-paper border-l-signal',
  completed: 'bg-[#e4e8ea] border-l-ok text-muted',
  no_show: 'bg-[#fdecea] border-l-danger',
  cancelled: 'bg-concrete border-l-line border-dashed opacity-70',
};
const STATUS_LABEL = { confirmed: '', completed: 'zakończona', no_show: 'nie przyjechał', cancelled: 'anulowana' } as const;

export function AppointmentCard({ a, compact, dense, onOpen, style }: {
  a: CalendarAppointment; compact?: boolean; dense?: boolean; onOpen: () => void; style: React.CSSProperties;
}) {
  const plate = a.registrationNumber ?? 'brak tablicy';
  if (dense) {
    // widok tygodnia: tylko tablica — szczegóły po kliknięciu
    return (
      <button type="button" onClick={onOpen} style={style} title={`${fmtTime(a.startsAt)} ${plate}, ${a.serviceName}`}
        aria-label={`${fmtTime(a.startsAt)}, ${a.serviceName}, ${plate}${STATUS_LABEL[a.status] ? `, ${STATUS_LABEL[a.status]}` : ''}`}
        className={`absolute inset-x-0.5 overflow-hidden rounded-[4px] border border-l-[3px] border-line px-1 text-left hover:z-10 hover:shadow-md ${STYLE[a.status]}`}>
        <span className={`block truncate font-display text-[0.8rem] font-bold leading-[1.1rem] ${a.status === 'no_show' ? 'line-through' : ''}`}>{plate}</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      style={style}
      aria-label={`${fmtTime(a.startsAt)}, ${a.serviceName}, ${plate}${a.customerName ? `, ${a.customerName}` : ''}${STATUS_LABEL[a.status] ? `, ${STATUS_LABEL[a.status]}` : ''}`}
      className={`absolute inset-x-1 overflow-hidden rounded-md border border-l-[5px] border-line px-2 py-1 text-left shadow-[0_1px_0_rgba(0,0,0,0.06)] hover:z-10 hover:shadow-md ${STYLE[a.status]}`}
    >
      <span className="flex items-baseline gap-1.5 leading-tight">
        <span className="text-[0.8rem] tabular-nums text-muted">{fmtTime(a.startsAt)}</span>
        <span className={`font-display text-[1.02rem] font-bold tracking-wide ${a.status === 'no_show' ? 'line-through' : ''}`}>{plate}</span>
        {a.source === 'online' && !compact && <span className="ml-auto hidden text-[0.72rem] text-muted lg:inline">online</span>}
      </span>
      {!compact && (
        <span className="block truncate text-[0.85rem] leading-tight">
          {a.serviceName}{a.customerName ? `, ${a.customerName}` : ''}
        </span>
      )}
    </button>
  );
}
