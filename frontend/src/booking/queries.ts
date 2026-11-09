import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../shared/api';
import type { BookedAppointment, BookingRequest, PublicInfo, Service, Slot } from './types';

export const keys = {
  info: ['info'] as const,
  services: ['services'] as const,
  days: (serviceId: number, from: string, to: string) => ['days', serviceId, from, to] as const,
  slots: (serviceId: number, date: string) => ['slots', serviceId, date] as const,
};

export const useInfo = () =>
  useQuery({ queryKey: keys.info, queryFn: () => api<PublicInfo>('/public/info'), staleTime: 5 * 60_000 });

export const useServices = () =>
  useQuery({ queryKey: keys.services, queryFn: () => api<{ services: Service[] }>('/public/services').then((r) => r.services), staleTime: 5 * 60_000 });

export const useAvailableDays = (serviceId: number | null, from: string, to: string) =>
  useQuery({
    queryKey: keys.days(serviceId ?? 0, from, to),
    queryFn: () => api<{ days: string[] }>(`/public/availability/days?serviceId=${serviceId}&from=${from}&to=${to}`).then((r) => new Set(r.days)),
    enabled: serviceId !== null,
    staleTime: 30_000,
  });

export const useSlots = (serviceId: number | null, date: string | null) =>
  useQuery({
    queryKey: keys.slots(serviceId ?? 0, date ?? ''),
    queryFn: () => api<{ slots: Slot[] }>(`/public/availability?serviceId=${serviceId}&date=${date}`).then((r) => r.slots),
    enabled: serviceId !== null && date !== null,
    staleTime: 15_000,
    refetchInterval: 60_000, // terminy znikają — odświeżaj, gdy klient długo się zastanawia
  });

export const useCreateBooking = () =>
  useMutation({
    mutationFn: ({ body, idempotencyKey }: { body: BookingRequest; idempotencyKey: string }) =>
      api<{ appointment: BookedAppointment }>('/public/bookings', {
        method: 'POST',
        json: body,
        headers: { 'Idempotency-Key': idempotencyKey },
      }).then((r) => r.appointment),
  });
