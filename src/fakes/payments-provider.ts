import {createHash} from 'node:crypto';
import type {FakeHandler, FakeReply, FakeRequest} from '../transport/fake.ts';
import {feeRefunded} from '../marketplace/split.ts';

type Intent = {
  id: string;
  object: 'payment_intent';
  amount: number;
  amount_refunded: number;
  currency: string;
  status: 'succeeded' | 'processing' | 'requires_payment_method';
  application_fee_amount: number;
  transfer_data: {destination: string};
  metadata: Record<string, string>;
  livemode: false;
  created: number;
};

/**
 * In-memory stand-in for a Stripe-shaped payments API (the subset the adapter uses). It honours idempotency keys the
 * way real providers do (same key + same body = same response; same key + different body = error) and keeps balances
 * so tests can prove that money moved exactly once.
 *
 * Test payment methods: `pm_card_ok` succeeds, `pm_card_declined` is declined, `pm_async` stays processing until
 * `settle()` is called.
 */
export function fakePaymentsProvider({apiKey}: {apiKey: string}) {
  const intents = new Map<string, Intent>();
  const accounts = new Set<string>();
  const balances = new Map<string, number>();
  const idempotency = new Map<string, {digest: string; reply: FakeReply}>();
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}_F${String(++seq).padStart(6, '0')}`;
  const credit = (account: string, cents: number) => balances.set(account, (balances.get(account) ?? 0) + cents);
  const err = (status: number, type: string, extra: Record<string, unknown> = {}): FakeReply => ({status, body: {error: {type, ...extra}}});

  function createIntent(form: URLSearchParams): FakeReply {
    const amount = Number(form.get('amount'));
    const fee = Number(form.get('application_fee_amount') ?? 0);
    const destination = form.get('transfer_data[destination]') ?? '';
    if (!Number.isSafeInteger(amount) || amount <= 0 || !Number.isSafeInteger(fee) || fee < 0 || fee > amount) return err(400, 'invalid_request_error');
    if (!accounts.has(destination)) return err(400, 'invalid_request_error', {param: 'transfer_data[destination]'});
    const metadata: Record<string, string> = {};
    for (const [k, v] of form) {
      const m = /^metadata\[([a-z_]+)\]$/.exec(k);
      if (m) metadata[m[1]!] = v;
    }
    const method = form.get('payment_method');
    const intent: Intent = {
      id: nextId('pi'), object: 'payment_intent', amount, amount_refunded: 0, currency: form.get('currency') ?? 'usd',
      status: method === 'pm_card_declined' ? 'requires_payment_method' : method === 'pm_async' ? 'processing' : 'succeeded',
      application_fee_amount: fee, transfer_data: {destination}, metadata, livemode: false, created: Math.floor(Date.now() / 1000),
    };
    intents.set(intent.id, intent);
    if (intent.status === 'succeeded') capture(intent);
    if (intent.status === 'requires_payment_method') return err(402, 'card_error', {code: 'card_declined', payment_intent: {...intent}});
    return {status: 200, body: {...intent}};
  }

  // Destination charge: the seller gets gross minus fee, the platform keeps the fee, in one movement.
  function capture(intent: Intent) {
    credit(intent.transfer_data.destination, intent.amount - intent.application_fee_amount);
    credit('platform', intent.application_fee_amount);
  }

  function createRefund(form: URLSearchParams): FakeReply {
    const intent = intents.get(form.get('payment_intent') ?? '');
    const amount = Number(form.get('amount'));
    if (!intent || intent.status !== 'succeeded') return err(400, 'invalid_request_error');
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > intent.amount - intent.amount_refunded) return err(400, 'invalid_request_error', {code: 'amount_too_large'});
    const before = feeRefunded(intent.application_fee_amount, intent.amount, intent.amount_refunded);
    intent.amount_refunded += amount;
    const feeBack = form.get('refund_application_fee') === 'true' ? feeRefunded(intent.application_fee_amount, intent.amount, intent.amount_refunded) - before : 0;
    credit('platform', -feeBack);
    credit(intent.transfer_data.destination, -(amount - feeBack));
    const metadata = form.get('metadata[operation_id]') ? {operation_id: form.get('metadata[operation_id]')!} : {};
    return {status: 200, body: {id: nextId('re'), object: 'refund', amount, payment_intent: intent.id, status: 'succeeded', metadata}};
  }

  function search(query: string): FakeReply {
    const m = /^metadata\['([a-z_]+)'\]:'([^']*)'$/.exec(query);
    if (!m) return err(400, 'invalid_request_error');
    const data = [...intents.values()].filter((i) => i.metadata[m[1]!] === m[2]);
    return {status: 200, body: {object: 'search_result', data: data.map((i) => ({...i}))}};
  }

  const handler: FakeHandler = (req: FakeRequest) => {
    if (req.headers.authorization !== `Bearer ${apiKey}`) return err(401, 'authentication_error');
    const path = req.url.pathname.replace(/^\/v1/, '');
    if (req.method === 'GET') {
      if (path === '/payment_intents/search') return search(req.url.searchParams.get('query') ?? '');
      const intent = intents.get(path.replace('/payment_intents/', ''));
      return intent ? {status: 200, body: {...intent}} : err(404, 'invalid_request_error', {code: 'resource_missing'});
    }
    const key = req.headers['idempotency-key'];
    const digest = createHash('sha256').update(req.method + path + req.body).digest('hex');
    if (key) {
      const seen = idempotency.get(key);
      if (seen) return seen.digest === digest ? structuredClone(seen.reply) : err(400, 'idempotency_error');
    }
    const form = new URLSearchParams(req.body);
    const out = path === '/payment_intents' ? createIntent(form) : path === '/refunds' ? createRefund(form) : err(404, 'invalid_request_error');
    if (key && out.status < 500) idempotency.set(key, {digest, reply: structuredClone(out)});
    return out;
  };

  return {
    handler,
    addAccount: (id: string) => void accounts.add(id),
    balance: (account: string) => balances.get(account) ?? 0,
    /** Number of payment objects created for one of our operations: the "was I charged twice?" check. */
    countFor: (operationId: string) => [...intents.values()].filter((i) => i.metadata.operation_id === operationId).length,
    intentCount: () => intents.size,
    /** Completes an async payment and returns the webhook event the provider would send. */
    settle(id: string, outcome: 'succeeded' | 'failed' = 'succeeded') {
      const intent = intents.get(id);
      if (!intent || intent.status !== 'processing') throw new Error('not processing: ' + id);
      intent.status = outcome === 'succeeded' ? 'succeeded' : 'requires_payment_method';
      if (outcome === 'succeeded') capture(intent);
      return event(outcome === 'succeeded' ? 'payment_intent.succeeded' : 'payment_intent.payment_failed', intent);
    },
  };

  function event(type: string, object: Intent) {
    return JSON.stringify({id: nextId('evt'), object: 'event', type, created: Math.floor(Date.now() / 1000), livemode: false, data: {object: {...object}}});
  }
}

export type FakePaymentsProvider = ReturnType<typeof fakePaymentsProvider>;
