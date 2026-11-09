export type ChannelName = 'whatsapp' | 'sms';
export type NotificationKind = 'confirmation' | 'reminder_24h' | 'reschedule' | 'cancellation';

/** Treść niezależna od kanału — każdy adapter bierze z niej to, czego potrzebuje. */
export interface RenderedMessage {
  kind: NotificationKind;
  /** parametry szablonu WhatsApp w kolejności {{1}}, {{2}}, ... */
  templateParams: string[];
  /** pełny tekst — dla SMS i logów (WhatsApp wysyła zatwierdzony szablon, nie dowolny tekst) */
  text: string;
}

export interface OutgoingMessage {
  to: string;                // E.164, np. +48600100200
  message: RenderedMessage;
  callbackData: string;      // id powiadomienia — wraca w webhooku statusu
}

export type SendResult =
  | { status: 'accepted'; providerMessageId: string }
  /** chwilowy problem (sieć, 5xx, limity) — ponów później tym samym kanałem */
  | { status: 'retry'; errorCode: string; error: string }
  /** trwały problem — nie ponawiaj; spróbuj kolejnego kanału (np. SMS) */
  | { status: 'failed'; errorCode: string; error: string };

/**
 * Kontrakt kanału powiadomień. Dodanie SMS = nowa klasa implementująca ten interfejs
 * + rejestracja w registry.ts + "sms" w app_settings.notification_channels.
 */
export interface MessageChannel {
  readonly name: ChannelName;
  readonly provider: string;
  /** czy klient musi mieć aktywną zgodę na ten kanał (WhatsApp: tak; SMS transakcyjny: nie) */
  readonly requiresOptIn: boolean;
  send(msg: OutgoingMessage): Promise<SendResult>;
}
