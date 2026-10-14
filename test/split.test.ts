import assert from 'node:assert/strict';
import {test} from 'node:test';
import {computeSplit, feeRefunded, EXAMPLE_FEE_POLICY} from '../src/marketplace/split.ts';
import {world} from './helpers.ts';

test('split adds up and never takes more than the gross', () => {
  const s = computeSplit(10_000, 'basic');
  assert.equal(s.commissionCents, 1111);
  assert.equal(s.processingCents, 333 + 33);
  assert.equal(s.commissionCents + s.processingCents + s.sellerNetCents, 10_000);
  const tiny = computeSplit(1, 'basic');
  assert.ok(tiny.sellerNetCents >= 0 && tiny.applicationFeeCents <= 1);
  assert.throws(() => computeSplit(10.5, 'basic'));
  assert.throws(() => computeSplit(100, 'gold'));
  assert.equal(computeSplit(10_000, 'plus', EXAMPLE_FEE_POLICY).rateBps, 777);
});

test('commission travels inside the payment: one charge, seller gets net, platform keeps the fee', async () => {
  const w = await world();
  const order = await w.market.createOrder({creatorId: 'creator-a', amountCents: 12_345, currency: 'usd', paymentMethod: 'pm_card_ok'});
  const paid = await w.market.pay(order.id);
  const payment = await w.payments.getPayment(paid.paymentId!);
  assert.equal(payment.applicationFeeCents, order.split.applicationFeeCents);
  assert.equal(w.provider.balance('acct_creatorA'), order.split.sellerNetCents);
  assert.equal(w.provider.balance('platform'), order.split.applicationFeeCents);
  assert.equal(w.provider.intentCount(), 1);
});

test('partial refunds return the fee proportionally with no cent of drift', async () => {
  const w = await world();
  const order = await w.market.createOrder({creatorId: 'creator-a', amountCents: 10_001, currency: 'usd', paymentMethod: 'pm_card_ok'});
  await w.market.pay(order.id);
  await w.market.refund(order.id, 3_333);
  const partial = await w.market.refund(order.id, 3_333);
  assert.equal(partial.status, 'partially_refunded');
  const full = await w.market.refund(order.id, 3_335);
  assert.equal(full.status, 'refunded');
  assert.equal(w.provider.balance('platform'), 0);
  assert.equal(w.provider.balance('acct_creatorA'), 0);
  const ledger = await w.store.tx((tx) => tx.ledger(order.id));
  assert.equal(ledger.reduce((s, e) => s + e.amountCents, 0), 0);
  assert.equal(feeRefunded(100, 1000, 1000), 100);
  await assert.rejects(w.market.refund(order.id, 1));
});
