export interface Service {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  priceFromPln: number | null;
  category: string | null;
  shortName: string | null;
}
export interface PriceInfo { note?: string; groupNotes: Record<string, string>; items: { label: string; price: string }[] }
export interface LegalDoc { version: string; url: string; text: string | null }
export interface PublicInfo {
  businessName: string;
  phone: string | null;
  address: string | null;
  timezone: string;
  bookingHorizonDays: number;
  priceInfo: PriceInfo | null;
  legal: { terms: LegalDoc | null; privacy: LegalDoc | null };
  whatsappConsent: LegalDoc | null;
}
export interface Slot { startsAt: string; endsAt: string }
export interface BookingRequest {
  serviceId: number;
  startsAt: string;
  fullName: string;
  phone: string;
  vehicle: { make: string; model: string; registrationNumber: string };
  notes?: string;
  acceptTerms: true;
  whatsappOptIn: boolean;
}
export interface BookedAppointment {
  referenceCode: string;
  startsAt: string;
  endsAt: string;
  serviceName: string;
  status: string;
}
