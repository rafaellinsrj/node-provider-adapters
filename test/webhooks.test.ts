import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {test} from 'node:test';
import type {ProviderError} from '../src/errors.ts';
import {fakeTransport} from '../src/transport/fake.ts';
import {hostedKyc} from '../src/providers/kyc.ts';
import {createWebhookProcessor} from '../src/webhooks/processor.ts';
import {signStripeStyle, verifyStripeStyle} from '../src/webhooks/signature.ts';
import {fakeSecret, world} from './helpers.ts';

const body = Buffer.from(JSON.stringify({id: 'evt_1', type: 'ping', created: 1}));
const nowS = () => Math.floor(Date.now() / 1000);

test('signature: valid, tampered body, tampered signature, expired, future, malformed', () => {
  const secret = fakeSecret('whsec');
  const header = signStripeStyle(body, secret);
  assert.ok(verifyStripeStyle(body, header, [secret]));
  assert.ok(!verifyStripeStyle(Buffer.from(body.toString().replace('ping', 'pong')), header, [secret]), 'tampered body');
  const flipped = header.slice(0, -1) + (header.endsWith('0') ? '1' : '0');
  assert.ok(!verifyStripeStyle(body, flipped, [secret]), 'tampered signature');
  assert.ok(!verifyStripeStyle(body, signStripeStyle(body, secret, nowS() - 301), [secret]), 'expired');
  assert.ok(!verifyStripeStyle(body, signStripeStyle(body, secret, nowS() + 301), [secret]), 'from the future');
  assert.ok(!verifyStripeStyle(body, header, [fakeSecret('whsec')]), 'other secret');
  assert.ok(!verifyStripeStyle(body, null, [secret]));
  assert.ok(!verifyStripeStyle(body, 'v1=abc', [secret]));
  assert.ok(!verifyStripeStyle(body, header, []), 'no secret configured = reject');
  // Changing the timestamp invalidates the signature (it is part of the signed payload).
  const t = Number(/t=(\d+)/.exec(header)![1]);
  assert.ok(!verifyStripeStyle(body, header.replace(`t=${t}`, `t=${t + 1}`), [secret]));
});

test('signature: secret rotation on both sides', () => {
  const oldSecret = fakeSecret('whsec');
  const newSecret = fakeSecret('whsec');
  // Provider rolling: it sends two v1 signatures while we still only know the old secret.
  const t = nowS();
  const both = `${signStripeStyle(body, newSecret, t)},v1=${/v1=(\w+)/.exec(signStripeStyle(body, oldSecret, t))![1]}`;
  assert.ok(verifyStripeStyle(body, both, [oldSecret]));
  // We rolling: during the overlap both local secrets are accepted...
  assert.ok(verifyStripeStyle(body, signStripeStyle(body, oldSecret), [newSecret, oldSecret]));
  assert.ok(verifyStripeStyle(body, signStripeStyle(body, newSecret), [newSecret, oldSecret]));
  // ...and once the old one is removed, its signatures stop working.
  assert.ok(!verifyStripeStyle(body, signStripeStyle(body, oldSecret), [newSecret]));
});

async function webhookWorld() {
  const w = await world();
  const secret = fakeSecret('whsec');
  const handle = createWebhookProcessor({
    store: w.store,
    provider: 'payments',
    secrets: () => [secret],
    handlers: {
      'payment_intent.succeeded': (e) => w.market.paymentEvent(String(e.data.object.id)),
      'payment_intent.payment_failed': (e) => w.market.paymentEvent(String(e.data.object.id)),
    },
  });
  const deliver = (raw: string) => handle(Buffer.from(raw), signStripeStyle(raw, secret));
  return {...w, secret, handle, deliver};
}

test('async payment completes through a verified webhook; redelivery is a no-op', async () => {
  const w = await webhookWorld();
  const order = await w.market.createOrder({creatorId: 'creator-a', amountCents: 2500, currency: 'usd', paymentMethod: 'pm_async'});
  const pending = await w.market.pay(order.id);
  assert.equal(pending.status, 'pending');

  const intentId = (await w.payments.findByOperation((await w.store.tx((tx) => tx.findOperation(order.id, 'charge')))!.id))!.id;
  const event = w.provider.settle(intentId);
  assert.deepEqual(await w.deliver(event), {eventId: JSON.parse(event).id, duplicate: false, ignored: false});
  assert.equal((await w.store.tx((tx) => tx.getOrder(order.id)))!.status, 'paid');
  const ledgerAfterFirst = await w.store.tx((tx) => tx.ledger());

  // Same event again (provider retry, or an attacker replaying a captured request within the window).
  assert.equal((await w.deliver(event)).duplicate, true);
  // Concurrent duplicate deliveries: exactly one applies.
  const again = await Promise.all([w.deliver(event), w.deliver(event)]);
  assert.ok(again.every((r) => r.duplicate));
  assert.deepEqual(await w.store.tx((tx) => tx.ledger()), ledgerAfterFirst);
  assert.equal((await w.store.tx((tx) => tx.findOperation(order.id, 'charge')))!.status, 'succeeded');
});

test('first-time concurrent deliveries of the same event apply once', async () => {
  const w = await webhookWorld();
  const order = await w.market.createOrder({creatorId: 'creator-a', amountCents: 2500, currency: 'usd', paymentMethod: 'pm_async'});
  await w.market.pay(order.id);
  const op = (await w.store.tx((tx) => tx.findOperation(order.id, 'charge')))!;
  const event = w.provider.settle((await w.payments.findByOperation(op.id))!.id);
  const results = await Promise.all([w.deliver(event), w.deliver(event), w.deliver(event)]);
  assert.equal(results.filter((r) => !r.duplicate).length, 1);
  assert.equal((await w.store.tx((tx) => tx.ledger(order.id))).length, 3);
});

test('webhook payload is a hint: the processor re-reads the provider, so a forged amount cannot mark an order paid', async () => {
  const w = await webhookWorld();
  const order = await w.market.createOrder({creatorId: 'creator-a', amountCents: 2500, currency: 'usd', paymentMethod: 'pm_async'});
  await w.market.pay(order.id);
  const op = (await w.store.tx((tx) => tx.findOperation(order.id, 'charge')))!;
  const intent = (await w.payments.findByOperation(op.id))!;
  // Correctly signed (e.g. sent early by a buggy integration) but the provider still says "processing".
  const early = JSON.stringify({id: 'evt_early1', type: 'payment_intent.succeeded', created: nowS(), data: {object: {id: intent.id, status: 'succeeded'}}});
  await w.deliver(early);
  assert.equal((await w.store.tx((tx) => tx.getOrder(order.id)))!.status, 'pending');
});

test('bad signature and unknown types', async () => {
  const w = await webhookWorld();
  const raw = JSON.stringify({id: 'evt_x1', type: 'customer.created', created: nowS(), data: {object: {}}});
  await assert.rejects(w.handle(Buffer.from(raw), signStripeStyle(raw, fakeSecret('whsec'))), (e: ProviderError) => e.code === 'invalid_signature');
  await assert.rejects(w.handle(Buffer.from(raw), null), (e: ProviderError) => e.code === 'invalid_signature');
  assert.deepEqual(await w.deliver(raw), {eventId: 'evt_x1', duplicate: false, ignored: true});
  assert.equal((await w.deliver(raw)).duplicate, true);
  const bad = JSON.stringify({id: 'nope', type: 'x', created: 1});
  await assert.rejects(w.deliver(bad), (e: ProviderError) => e.code === 'invalid_event');
});

test('KYC webhook (hex HMAC + timestamp header) exposes only a coarse result', () => {
  const webhookSecret = fakeSecret('kyc');
  const kyc = hostedKyc({apiKey: fakeSecret('key'), workflowId: 'wf-demo', webhookSecret, baseUrl: 'https://kyc.example', transport: fakeTransport(() => ({status: 500, body: {}}))});
  const raw = Buffer.from(JSON.stringify({event_id: 'e1', session_id: 'sess-0001', vendor_data: 'req-1', status: 'Approved', decision: {document: 'never kept'}}));
  const sig = createHmac('sha256', webhookSecret).update(raw).digest('hex');
  const headers = new Headers({'x-signature': sig, 'x-timestamp': String(nowS())});
  assert.deepEqual(kyc.readWebhook(raw, headers), {eventId: 'e1', sessionId: 'sess-0001', reference: 'req-1', result: 'approved'});
  assert.throws(() => kyc.readWebhook(Buffer.concat([raw, Buffer.from(' ')]), headers), (e: ProviderError) => e.code === 'invalid_signature');
  const stale = new Headers({'x-signature': sig, 'x-timestamp': String(nowS() - 600)});
  assert.throws(() => kyc.readWebhook(raw, stale), (e: ProviderError) => e.code === 'invalid_signature');
});
