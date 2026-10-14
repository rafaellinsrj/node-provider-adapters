import {ProviderError} from '../errors.ts';
import type {Transport} from '../transport/types.ts';
import {callJson} from './http-json.ts';

export interface EmailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
}
export interface EmailAdapter {
  /** `outboxId` becomes the idempotency key: resending the same outbox row never sends a second e-mail. */
  send(outboxId: string, message: EmailMessage): Promise<{providerId: string}>;
}

// Adapter for a Resend-shaped API (JSON body, Bearer key, Idempotency-Key header).
export function resendLikeEmail({apiKey, transport, baseUrl = 'https://api.resend.com'}: {apiKey: string; transport: Transport; baseUrl?: string}): EmailAdapter {
  if (!apiKey) throw new ProviderError(503, 'not_configured');
  return {
    async send(outboxId, message) {
      const {status, body} = await callJson(
        transport,
        baseUrl + '/emails',
        {
          method: 'POST',
          headers: {authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'idempotency-key': 'outbox/' + outboxId},
          body: JSON.stringify(message),
        },
        {mutation: true},
      );
      if (status >= 400) throw new ProviderError(502, 'rejected');
      // A 2xx without a well-formed id is not proof of delivery.
      if (typeof body.id !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(body.id)) throw new ProviderError(503, 'invalid_result');
      return {providerId: body.id};
    },
  };
}
