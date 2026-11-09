import type { MessageChannel, NotificationKind, OutgoingMessage, SendResult } from './types.js';

/**
 * Nazwy szablonów (kategoria UTILITY) zatwierdzanych w WhatsApp Manager.
 * Treści do zgłoszenia: docs/whatsapp-templates.md
 */
export const WHATSAPP_TEMPLATES: Record<NotificationKind, string> = {
  confirmation: 'potwierdzenie_wizyty',
  reminder_24h: 'przypomnienie_wizyty',
  reschedule: 'zmiana_terminu_wizyty',
  cancellation: 'anulowanie_wizyty',
};

// https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes
// Chwilowe: przeciążenie, limity przepustowości, tryb konserwacji → ponów z opóźnieniem.
const RETRYABLE = new Set([1, 2, 4, 80007, 130429, 131000, 131016, 131056, 131057, 133004]);

export interface WhatsAppConfig {
  baseUrl: string;
  graphVersion: string;
  phoneNumberId: string;
  accessToken: string;
  language: string;
  timeoutMs?: number;
}

export class WhatsAppCloudChannel implements MessageChannel {
  readonly name = 'whatsapp' as const;
  readonly provider = 'meta_cloud';
  readonly requiresOptIn = true;

  constructor(private readonly cfg: WhatsAppConfig) {}

  async send({ to, message, callbackData }: OutgoingMessage): Promise<SendResult> {
    const url = `${this.cfg.baseUrl}/${this.cfg.graphVersion}/${this.cfg.phoneNumberId}/messages`;
    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to.replace(/^\+/, ''),
      type: 'template',
      biz_opaque_callback_data: callbackData, // wraca w webhooku → jednoznaczne powiązanie statusu z rekordem
      template: {
        name: WHATSAPP_TEMPLATES[message.kind],
        language: { code: this.cfg.language },
        components: [{ type: 'body', parameters: message.templateParams.map((text) => ({ type: 'text', text })) }],
      },
    };

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.cfg.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 15_000),
      });
    } catch (err) {
      return { status: 'retry', errorCode: 'NETWORK', error: err instanceof Error ? err.message : String(err) };
    }

    const json = (await res.json().catch(() => null)) as
      | { messages?: { id: string }[]; error?: { code?: number; message?: string; error_data?: { details?: string } } }
      | null;

    const id = json?.messages?.[0]?.id;
    if (res.ok && id) return { status: 'accepted', providerMessageId: id };

    const code = json?.error?.code;
    const error = [json?.error?.message, json?.error?.error_data?.details].filter(Boolean).join(' — ') || `HTTP ${res.status}`;
    if (code === undefined) {
      return res.status >= 500 || res.status === 429
        ? { status: 'retry', errorCode: `HTTP_${res.status}`, error }
        : { status: 'failed', errorCode: `HTTP_${res.status}`, error };
    }
    // Pozostałe kody (zły szablon 132001, numer bez WhatsAppa 131026, token 190, płatności 131042...)
    // są trwałe — ponawianie nic nie da, lepiej od razu spróbować zapasowego kanału.
    return RETRYABLE.has(code) ? { status: 'retry', errorCode: String(code), error } : { status: 'failed', errorCode: String(code), error };
  }
}
