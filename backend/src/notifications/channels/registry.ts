import { config } from '../../config.js';
import { LogChannel } from './log.js';
import type { ChannelName, MessageChannel } from './types.js';
import { WhatsAppCloudChannel } from './whatsapp.js';

export type ChannelRegistry = Map<ChannelName, MessageChannel>;

export function buildChannelRegistry(): ChannelRegistry {
  const registry: ChannelRegistry = new Map();

  if (config.WHATSAPP_MODE === 'cloud') {
    registry.set('whatsapp', new WhatsAppCloudChannel({
      baseUrl: config.WHATSAPP_API_BASE_URL,
      graphVersion: config.WHATSAPP_GRAPH_VERSION,
      phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID!,
      accessToken: config.WHATSAPP_ACCESS_TOKEN!,
      language: config.WHATSAPP_TEMPLATE_LANGUAGE,
    }));
  } else if (config.WHATSAPP_MODE === 'log') {
    registry.set('whatsapp', new LogChannel('whatsapp', true));
  }

  // MIEJSCE NA SMS: np.
  //   if (config.SMS_MODE === 'smsapi') registry.set('sms', new SmsApiChannel({ token: config.SMSAPI_TOKEN, from: config.SMS_SENDER }));
  // i w app_settings: notification_channels = ["whatsapp","sms"] (SMS jako zapasowy) albo ["sms"].
  // Treść SMS jest już gotowa: RenderedMessage.text (messages.ts).

  return registry;
}
