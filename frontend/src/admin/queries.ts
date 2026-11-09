import { useQuery } from '@tanstack/react-query';
import { adminApi } from './api';
import type { AdminService, AppointmentDetail, CalendarData } from './types';

export const useCalendar = (from: string, to: string) =>
  useQuery({
    queryKey: ['cal', from, to],
    queryFn: () => adminApi<CalendarData>(`/calendar?from=${from}&to=${to}`),
    refetchInterval: 30_000, // nowe rezerwacje online pojawiają się bez odświeżania strony
    placeholderData: (prev) => prev,
  });

export const useAdminServices = () =>
  useQuery({ queryKey: ['services'], queryFn: () => adminApi<{ services: AdminService[] }>('/services').then((r) => r.services), staleTime: 5 * 60_000 });

export const useAppointment = (id: string | null) =>
  useQuery({
    queryKey: ['appt', id],
    queryFn: () => adminApi<{ appointment: AppointmentDetail }>(`/appointments/${id}`).then((r) => r.appointment),
    enabled: !!id,
  });
