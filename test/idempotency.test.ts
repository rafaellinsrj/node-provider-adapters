import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {ProviderError} from '../src/errors.ts';
import {isPaymentCreate, world} from './helpers.ts';

test('preparing twice yields the same operation, hence the same idempotency key', async () => {
  const w = await world();
  const order = await w.market.createOrder({creatorId: 'creator-a', amountCents: 5000, currency: 'usd', paymentMethod: 'pm_card_ok'});
  const [a, b] = await w.store.tx(async (tx) => [
    await w.operations.prepare(tx, {kind: 'charge', subjectId: order.id, request: {}}),
    await w.operations.prepare(tx, {kind: 'charge', subjectId: order.id, request: {other: true}}),
  ]);
  assert.equal(a!.id, b!.id);
  assert.equal(w.operations.keyOf(a!), w.operations.keyOf(b!));
});

test('paying twice charges once; the second call returns the stored result without calling the provider', async () => {
  const w = await world();
  const order = await w.market.createOrder({creatorId: 'creator-a', amountCents: 5000, currency: 'usd', paymentMethod: 'pm_card_ok'});
  const first = await w.market.pay(order.id);
  const second = await w.market.pay(order.id);
  assert.equal(first.status, 'paid');
  assert.equal(second.paymentId, first.paymentId);
  assert.equal(w.transport.calls.filter(isPaymentCreate).length, 1);
  assert.equal(w.provider.intentCount(), 1);
});

test('concurrent pay() calls: one claims the lease, the other is told the call is in progress', async () => {
  const w = await world();
  const order = await w.market.createOrder({creatorId: 'creator-a', amountCents: 5000, currency: 'usd', paymentMethod: 'pm_card_ok'});
  const results = await Promise.allSettled([w.market.pay(order.id), w.market.pay(order.id)]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  const busy = results.filter((r) => r.status === 'rejected' && (r.reason as ProviderError).code === 'operation_in_progress');
  assert.equal(ok.length + busy.length, 2);
  assert.ok(ok.length >= 1);
  assert.equal(w.provider.intentCount(), 1);
});

test('provider honours key reuse: same key + same body = same object; same key + different body = rejected', async () => {
  const w = await world();
  const base = {amountCents: 1000, currency: 'usd', destination: 'acct_creatorA', applicationFeeCents: 10, paymentMethod: 'pm_card_ok', orderId: 'ord_x', operationId: 'op_x'};
  const a = await w.payments.createPayment(base, 'same-key');
  const b = await w.payments.createPayment(base, 'same-key');
  assert.equal(a.id, b.id);
  await assert.rejects(w.payments.createPayment({...base, amountCents: 999}, 'same-key'), (e: ProviderError) => e.code === 'rejected');
  assert.equal(w.provider.intentCount(), 1);
});

test('changing the provider account invalidates pending operations instead of reusing their keys', async () => {
  const w = await world();
  const order = await w.market.createOrder({creatorId: 'creator-a', amountCents: 5000, currency: 'usd', paymentMethod: 'pm_card_ok'});
  const {createOperations} = await import('../src/operations/operations.ts');
  const other = createOperations(w.store, {configDigest: 'cfg-2'});
  const op = await w.store.tx((tx) => tx.findOperation(order.id, 'charge'));
  await assert.rejects(other.execute(op!.id, async () => ({status: 'succeeded', result: {}})), (e: ProviderError) => e.code === 'configuration_changed');
});
