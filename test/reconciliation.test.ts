import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {ProviderError} from '../src/errors.ts';
import {SAFE_REPLAY_MS} from '../src/operations/operations.ts';
import {isPaymentCreate, world} from './helpers.ts';

const MINUTE = 60_000;

async function orderWith(paymentMethod: string) {
  const w = await world();
  const order = await w.market.createOrder({creatorId: 'creator-a', amountCents: 8000, currency: 'usd', paymentMethod});
  const op = (await w.store.tx((tx) => tx.findOperation(order.id, 'charge')))!;
  return {...w, order, op};
}

test('timeout AFTER the provider charged -> unknown -> reconciliation finds the payment -> paid, charged once', async () => {
  const w = await orderWith('pm_card_ok');
  w.transport.failNext(isPaymentCreate, {kind: 'timeout-after'});
  await assert.rejects(w.market.pay(w.order.id), (e: ProviderError) => e.code === 'outcome_unknown');

  const op = await w.store.tx((tx) => tx.getOperation(w.op.id));
  assert.equal(op!.status, 'unknown');
  assert.equal((await w.store.tx((tx) => tx.getOrder(w.order.id)))!.status, 'pending');
  // Money already moved at the provider even though we did not get the answer.
  assert.equal(w.provider.countFor(w.op.id), 1);

  // A blind retry is refused: first find out what happened.
  await assert.rejects(w.market.pay(w.order.id), (e: ProviderError) => e.code === 'reconciliation_required');

  w.time.advance(5 * MINUTE);
  assert.deepEqual(await w.market.reconcileDue(), [{orderId: w.order.id, status: 'paid'}]);
  assert.equal(w.provider.countFor(w.op.id), 1, 'no second charge');
  assert.equal(w.transport.calls.filter(isPaymentCreate).length, 1);

  const split = w.order.split;
  assert.equal(w.provider.balance('acct_creatorA'), split.sellerNetCents);
  assert.equal(w.provider.balance('platform'), split.applicationFeeCents);
  const ledger = await w.store.tx((tx) => tx.ledger(w.order.id));
  assert.equal(ledger.reduce((s, e) => s + e.amountCents, 0), 8000);
  // Running reconciliation again changes nothing.
  assert.deepEqual(await w.market.reconcileDue(), []);
});

test('timeout BEFORE the request arrived -> provider has nothing -> retried with the SAME key -> paid once', async () => {
  const w = await orderWith('pm_card_ok');
  w.transport.failNext(isPaymentCreate, {kind: 'timeout-before'});
  await assert.rejects(w.market.pay(w.order.id), (e: ProviderError) => e.code === 'outcome_unknown');
  assert.equal(w.provider.countFor(w.op.id), 0);

  w.time.advance(5 * MINUTE);
  assert.deepEqual(await w.market.reconcileDue(), [{orderId: w.order.id, status: 'paid'}]);
  const keys = w.transport.calls.filter(isPaymentCreate).map((c) => c.headers['idempotency-key']);
  assert.deepEqual(keys, ['op-' + w.op.id, 'op-' + w.op.id]);
  assert.equal(w.provider.countFor(w.op.id), 1);
});

test('declined card behind a timeout -> reconciliation resolves to failed, no ledger entries', async () => {
  const w = await orderWith('pm_card_declined');
  w.transport.failNext(isPaymentCreate, {kind: 'timeout-after'});
  await assert.rejects(w.market.pay(w.order.id));
  w.time.advance(5 * MINUTE);
  assert.deepEqual(await w.market.reconcileDue(), [{orderId: w.order.id, status: 'failed'}]);
  assert.equal((await w.store.tx((tx) => tx.getOperation(w.op.id)))!.status, 'failed');
  assert.deepEqual(await w.store.tx((tx) => tx.ledger(w.order.id)), []);
  assert.equal(w.provider.balance('platform'), 0);
});

test('nothing found after the idempotency-key window -> blocked for review, never replayed', async () => {
  const w = await orderWith('pm_card_ok');
  w.transport.failNext(isPaymentCreate, {kind: 'timeout-before'});
  await assert.rejects(w.market.pay(w.order.id));
  w.time.advance(SAFE_REPLAY_MS + MINUTE);
  assert.deepEqual(await w.market.reconcileDue(), [{orderId: w.order.id, status: 'pending'}]);
  assert.equal((await w.store.tx((tx) => tx.getOperation(w.op.id)))!.status, 'blocked');
  await assert.rejects(w.market.pay(w.order.id), (e: ProviderError) => e.code === 'review_required');
  assert.equal(w.transport.calls.filter(isPaymentCreate).length, 1);
});

test('worker died mid-call (lease expired while running) is treated like a timeout', async () => {
  const w = await orderWith('pm_card_ok');
  // Simulate a crash: the provider got the request, the process never wrote the result.
  await w.payments.createPayment({amountCents: 8000, currency: 'usd', destination: 'acct_creatorA', applicationFeeCents: w.order.split.applicationFeeCents, paymentMethod: 'pm_card_ok', orderId: w.order.id, operationId: w.op.id}, 'op-' + w.op.id);
  await w.store.tx((tx) => tx.updateOperation(w.op.id, {status: 'running', attempts: 1, firstAttemptAt: w.time.now(), leaseToken: 'dead', leaseUntil: new Date(w.time.now().getTime() + MINUTE)}));
  await assert.rejects(w.market.pay(w.order.id), (e: ProviderError) => e.code === 'operation_in_progress');
  w.time.advance(2 * MINUTE);
  assert.deepEqual(await w.market.reconcileDue(), [{orderId: w.order.id, status: 'paid'}]);
  assert.equal(w.provider.countFor(w.op.id), 1);
});

test('a definitive 4xx is not retried: the operation is blocked', async () => {
  const w = await world();
  w.provider.addAccount('acct_other');
  await w.store.tx((tx) => tx.putCreator({id: 'creator-x', tier: 'plus', payoutAccount: 'acct_unknown'}));
  const order = await w.market.createOrder({creatorId: 'creator-x', amountCents: 3000, currency: 'usd', paymentMethod: 'pm_card_ok'});
  await assert.rejects(w.market.pay(order.id), (e: ProviderError) => e.code === 'rejected');
  const op = await w.store.tx((tx) => tx.findOperation(order.id, 'charge'));
  assert.equal(op!.status, 'blocked');
});
