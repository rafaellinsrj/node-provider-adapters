import {ProviderError} from '../errors.ts';
import type {Transport} from '../transport/types.ts';
import {verifyHexHmac} from '../webhooks/signature.ts';
import {callJson} from './http-json.ts';

// Identity verification behind an adapter. Only a coarse result leaves this file: the decision payload of a KYC
// provider carries documents and personal data, which the platform never stores or logs.
export type KycResult = 'started' | 'approved' | 'declined' | 'expired' | 'retry';
const STATUS: Record<string, KycResult> = {
  'Not Started': 'started',
  'In Progress': 'started',
  'In Review': 'started',
  Approved: 'approved',
  Declined: 'declined',
  Expired: 'expired',
  Abandoned: 'retry',
};
export const kycResult = (status: unknown): KycResult | null => (typeof status === 'string' ? (STATUS[status] ?? null) : null);

export interface KycAdapter {
  createSession(input: {reference: string; callbackUrl: string}): Promise<{sessionId: string; url: string; result: KycResult}>;
  decision(sessionId: string): Promise<KycResult | null>;
  readWebhook(raw: Buffer, headers: Headers, now?: number): {eventId: string | null; sessionId: string; reference: string | null; result: KycResult | null};
}

const SESSION = /^[A-Za-z0-9-]{8,80}$/;

export function hostedKyc(config: {apiKey: string; workflowId: string; webhookSecret: string; transport: Transport; baseUrl: string}): KycAdapter {
  if (!config.apiKey || !config.workflowId || !config.webhookSecret) throw new ProviderError(503, 'not_configured');
  const headers = {'x-api-key': config.apiKey, accept: 'application/json'};
  return {
    async createSession({reference, callbackUrl}) {
      // `reference` is our request id: no personal data is sent to the provider.
      const {status, body} = await callJson(
        config.transport,
        config.baseUrl + '/v1/session',
        {method: 'POST', headers: {...headers, 'content-type': 'application/json'}, body: JSON.stringify({workflow_id: config.workflowId, vendor_data: reference, callback: callbackUrl})},
        {mutation: true},
      );
      if (status >= 400) throw new ProviderError(502, 'rejected');
      let url: URL;
      try {
        url = new URL(String(body.url));
      } catch {
        throw new ProviderError(502, 'invalid_result');
      }
      // Never redirect a person to a non-HTTPS or credential-bearing URL handed back by a third party.
      if (url.protocol !== 'https:' || url.username || url.password || !SESSION.test(String(body.session_id))) throw new ProviderError(502, 'invalid_result');
      return {sessionId: String(body.session_id), url: url.href, result: kycResult(body.status) ?? 'started'};
    },
    async decision(sessionId) {
      if (!SESSION.test(sessionId)) throw new ProviderError(422, 'path_denied');
      const {status, body} = await callJson(config.transport, `${config.baseUrl}/v1/session/${sessionId}/decision`, {method: 'GET', headers}, {mutation: false});
      if (status >= 400) throw new ProviderError(502, 'rejected');
      return kycResult(body.status);
    },
    readWebhook(raw, h, now = Date.now()) {
      // Hex HMAC-SHA256 of the raw body plus a Unix-seconds timestamp header (a common KYC-provider scheme).
      if (!verifyHexHmac(raw, h.get('x-signature'), h.get('x-timestamp'), [config.webhookSecret], now)) throw new ProviderError(401, 'invalid_signature');
      let v: Record<string, unknown>;
      try {
        v = JSON.parse(raw.toString('utf8'));
      } catch {
        throw new ProviderError(400, 'bad_payload');
      }
      if (!SESSION.test(String(v.session_id))) throw new ProviderError(422, 'invalid_event');
      return {
        eventId: typeof v.event_id === 'string' && v.event_id.length <= 100 ? v.event_id : null,
        sessionId: String(v.session_id),
        reference: typeof v.vendor_data === 'string' ? v.vendor_data : null,
        result: kycResult(v.status),
      };
    },
  };
}
