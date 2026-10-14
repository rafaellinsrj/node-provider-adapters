import {ProviderError} from '../errors.ts';
import type {Transport} from '../transport/types.ts';
import {assertRunning, callJson, neverPaused, type PauseSwitch} from './http-json.ts';

// What business code sees. No provider types leak past this file.
export type PaymentStatus = 'succeeded' | 'processing' | 'failed';
export interface Payment {
  id: string;
  status: PaymentStatus;
  amountCents: number;
  currency: string;
  applicationFeeCents: number;
  destination: string | null;
  operationId: string | null;
  orderId: string | null;
}
export interface Refund {
  id: string;
  status: 'succeeded' | 'pending' | 'failed';
  amountCents: number;
  paymentId: string;
  operationId: string | null;
}
export interface CreatePayment {
  amountCents: number;
  currency: string;
  /** Connected account of the seller that receives the funds (destination charge). */
  destination: string;
  /** Platform commission kept from the same charge. */
  applicationFeeCents: number;
  paymentMethod: string;
  orderId: string;
  operationId: string;
}
export interface PaymentsAdapter {
  createPayment(input: CreatePayment, idempotencyKey: string): Promise<Payment>;
  getPayment(id: string): Promise<Payment>;
  /** Looks a payment up by our own operation id (stored as metadata). Used by reconciliation after a timeout. */
  findByOperation(operationId: string): Promise<Payment | null>;
  createRefund(input: {paymentId: string; amountCents: number; operationId: string}, idempotencyKey: string): Promise<Refund>;
}

export interface StripeLikeConfig {
  apiKey: string;
  transport: Transport;
  baseUrl?: string;
  pause?: PauseSwitch;
}

// Only these endpoints can ever be called. A bug elsewhere cannot turn the adapter into a generic proxy.
const ALLOWED = [
  /^\/payment_intents$/,
  /^\/payment_intents\/pi_[A-Za-z0-9]+$/,
  /^\/payment_intents\/search\?query=[^&]+$/,
  /^\/refunds$/,
];
const ID = /^[A-Za-z0-9_-]{1,100}$/;

// Adapter for a Stripe-shaped API (form-encoded POSTs, Idempotency-Key header, destination charges with
// application_fee_amount). Modelled on the public API reference; the fake in src/fakes implements the same subset.
export function stripeLikePayments(config: StripeLikeConfig): PaymentsAdapter {
  const base = (config.baseUrl ?? 'https://api.stripe.com/v1').replace(/\/$/, '');
  const pause = config.pause ?? neverPaused;
  if (!config.apiKey) throw new ProviderError(503, 'not_configured');

  async function request(path: string, params: Record<string, string> | null, idempotencyKey?: string) {
    if (!ALLOWED.some((re) => re.test(path))) throw new ProviderError(422, 'path_denied');
    // The switch is checked on every call, reconciliation reads included.
    await assertRunning(pause, 'payments');
    const headers: Record<string, string> = {authorization: `Bearer ${config.apiKey}`, accept: 'application/json'};
    if (params) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    }
    return callJson(
      config.transport,
      base + path,
      {method: params ? 'POST' : 'GET', headers, body: params ? new URLSearchParams(params).toString() : undefined},
      {mutation: params !== null},
    );
  }

  return {
    async createPayment(input, idempotencyKey) {
      if (!ID.test(input.destination) || !ID.test(input.operationId) || !ID.test(input.orderId)) throw new ProviderError(422, 'path_denied');
      const {status, body} = await request(
        '/payment_intents',
        {
          amount: String(input.amountCents),
          currency: input.currency.toLowerCase(),
          confirm: 'true',
          payment_method: input.paymentMethod,
          application_fee_amount: String(input.applicationFeeCents),
          'transfer_data[destination]': input.destination,
          'metadata[order_id]': input.orderId,
          'metadata[operation_id]': input.operationId,
        },
        idempotencyKey,
      );
      // A declined card is a definitive answer: the provider returns the failed intent inside the error.
      const declined = (body.error as {payment_intent?: unknown} | undefined)?.payment_intent;
      if (status === 402 && declined) return toPayment(declined);
      if (status >= 400) throw new ProviderError(502, 'rejected');
      return toPayment(body);
    },
    async getPayment(id) {
      if (!/^pi_[A-Za-z0-9]+$/.test(id)) throw new ProviderError(422, 'path_denied');
      const {status, body} = await request('/payment_intents/' + id, null);
      if (status === 404) throw new ProviderError(404, 'not_found');
      if (status >= 400) throw new ProviderError(502, 'rejected');
      return toPayment(body);
    },
    async findByOperation(operationId) {
      if (!ID.test(operationId)) throw new ProviderError(422, 'path_denied');
      const query = encodeURIComponent(`metadata['operation_id']:'${operationId}'`);
      const {status, body} = await request('/payment_intents/search?query=' + query, null);
      if (status >= 400) throw new ProviderError(502, 'rejected');
      const data = Array.isArray(body.data) ? body.data : [];
      if (data.length > 1) throw new ProviderError(409, 'review_required');
      return data.length ? toPayment(data[0]) : null;
    },
    async createRefund(input, idempotencyKey) {
      const {status, body} = await request(
        '/refunds',
        {
          payment_intent: input.paymentId,
          amount: String(input.amountCents),
          // Give back the platform commission proportionally and pull the funds back from the seller.
          refund_application_fee: 'true',
          reverse_transfer: 'true',
          'metadata[operation_id]': input.operationId,
        },
        idempotencyKey,
      );
      if (status >= 400) throw new ProviderError(502, 'rejected');
      const r = body as Record<string, unknown>;
      if (typeof r.id !== 'string' || !Number.isSafeInteger(r.amount)) throw new ProviderError(502, 'invalid_result');
      return {
        id: r.id,
        status: r.status === 'succeeded' ? 'succeeded' : r.status === 'failed' || r.status === 'canceled' ? 'failed' : 'pending',
        amountCents: r.amount as number,
        paymentId: String(r.payment_intent),
        operationId: (r.metadata as Record<string, string> | undefined)?.operation_id ?? null,
      };
    },
  };
}

// Strict mapping. Anything unexpected is `invalid_result` (uncertain), never a guess.
function toPayment(raw: unknown): Payment {
  const v = raw as Record<string, unknown>;
  if (!v || typeof v.id !== 'string' || !/^pi_/.test(v.id) || !Number.isSafeInteger(v.amount) || typeof v.currency !== 'string') {
    throw new ProviderError(502, 'invalid_result');
  }
  const metadata = (v.metadata ?? {}) as Record<string, string>;
  const status: PaymentStatus =
    v.status === 'succeeded' ? 'succeeded' : v.status === 'requires_payment_method' || v.status === 'canceled' ? 'failed' : 'processing';
  return {
    id: v.id,
    status,
    amountCents: v.amount as number,
    currency: v.currency,
    applicationFeeCents: Number.isSafeInteger(v.application_fee_amount) ? (v.application_fee_amount as number) : 0,
    destination: (v.transfer_data as {destination?: string} | null)?.destination ?? null,
    operationId: metadata.operation_id ?? null,
    orderId: metadata.order_id ?? null,
  };
}
