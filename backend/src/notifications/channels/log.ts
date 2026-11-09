import { randomUUID } from 'node:crypto';
import { logger } from '../../lib/logger.js';
import type { ChannelName, MessageChannel, OutgoingMessage, SendResult } from './types.js';

/** Kanał deweloperski: zamiast wysyłać, zapisuje treść do logów. */
export class LogChannel implements MessageChannel {
  readonly provider = 'log';
  constructor(readonly name: ChannelName, readonly requiresOptIn: boolean) {}
  async send({ message, callbackData }: OutgoingMessage): Promise<SendResult> {
    // numer telefonu celowo pominięty (RODO w logach)
    logger.info({ channel: this.name, kind: message.kind, notificationId: callbackData, text: message.text }, 'Powiadomienie (tryb log)');
    return { status: 'accepted', providerMessageId: `log-${randomUUID()}` };
  }
}
