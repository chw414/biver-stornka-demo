export type Role = 'owner' | 'staff';
export interface Admin { id: string; email: string; fullName: string; role: Role }
export type ApptStatus = 'confirmed' | 'completed' | 'cancelled' | 'no_show';
export type ApptSource = 'online' | 'phone' | 'walk_in';

export interface Station { id: number; name: string; isActive: boolean }
export interface OpeningWindow { day: string; opensAt: string; closesAt: string; reason: string | null }
export interface CalendarAppointment {
  id: string; referenceCode: string; startsAt: string; endsAt: string; status: ApptStatus; source: ApptSource;
  stationId: number; serviceId: number; serviceName: string; customerId: string; customerName: string | null; phone: string | null;
  make: string; model: string; registrationNumber: string | null; lockVersion: number;
}
export interface Block { id: string; stationId: number | null; startsAt: string; endsAt: string; reason: string | null }
export interface CalendarData {
  timezone: string; stations: Station[]; openingHours: OpeningWindow[]; appointments: CalendarAppointment[]; blocks: Block[];
}
export interface AdminService { id: number; name: string; durationMinutes: number; priceFromPln: number | null; isPublic: boolean; category: string | null; shortName: string | null }

export interface NotificationInfo {
  kind: 'confirmation' | 'reminder_24h' | 'reschedule' | 'cancellation';
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed' | 'cancelled';
  channel: 'whatsapp' | 'sms' | null; scheduledFor: string; sentAt: string | null; deliveredAt: string | null; readAt: string | null; errorCode: string | null;
}
export interface AppointmentDetail {
  id: string; referenceCode: string; status: ApptStatus; source: ApptSource; startsAt: string; endsAt: string;
  stationId: number; stationName: string; serviceId: number; serviceName: string; priceFromPln: number | null;
  customerNotes: string | null; adminNotes: string | null; bookedFullName: string | null;
  cancelledAt: string | null; cancelledBy: string | null; cancellationReason: string | null; lockVersion: number; createdAt: string;
  customer: { id: string; fullName: string | null; phone: string | null; whatsappOptIn: boolean };
  vehicle: { id: string; make: string; model: string; registrationNumber: string | null; tireSize: string | null };
  notifications: NotificationInfo[];
}
export interface CustomerRow {
  id: string; fullName: string; phone: string; createdAt: string; vehiclesCount: number; completedVisits: number; noShows: number;
  lastVisitAt: string | null; nextVisitAt: string | null; plates: string[];
}
export interface Vehicle { id: string; make: string; model: string; registrationNumber: string | null; tireSize: string | null; notes: string | null; createdAt: string }
export interface CustomerCard {
  id: string; fullName: string | null; phone: string | null; adminNotes: string | null; createdAt: string; anonymizedAt: string | null;
  whatsappOptIn: boolean; vehicles: Vehicle[];
  appointments: { id: string; referenceCode: string; vehicleId: string; startsAt: string; endsAt: string; status: ApptStatus; source: ApptSource; serviceName: string; adminNotes: string | null; stationId: number }[];
  consents: { kind: string; version: string; grantedAt: string; withdrawnAt: string | null }[];
}
export interface Health {
  notificationChannels: string[]; whatsappMode: string; calendarMode: string;
  notifications: { overdue: number; failed7d: number; noChannel7d: number; sent7d: number; topErrors: { code: string; channel: string | null; count: number; lastAt: string }[] };
  calendarSync: { failed: number; pending: number; oldestPendingAt: string | null };
}
