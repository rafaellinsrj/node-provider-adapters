import {randomUUID} from 'node:crypto';
import {ProviderError} from '../errors.ts';
import type {Operations, Outcome} from '../operations/operations.ts';
import type {Payment, PaymentsAdapter} from '../providers/payments.ts';
import type {LedgerEntry, Order, Store, Tx} from '../store/types.ts';
import {computeSplit, feeRefunded, type FeePolicy} from './split.ts';

const outcomeOf = (p: Payment): Outcome => ({
  status: p.status === 'succeeded' ? 'succeeded' : p.status === 'failed' ? 'failed' : 'pending',
  result: {...p},
});

// Orders of a creator marketplace. Business code talks to PaymentsAdapter and Operations only, never to an SDK.
export function createMarketplace({store, payments, operations, policy}: {store: Store; payments: PaymentsAdapter; operations: Operations; policy?: FeePolicy}) {
  /** Order row and charge intent are written in ONE transaction: there is never an order without its intent. */
  async function createOrder(input: {creatorId: string; amountCents: number; currency: string; paymentMethod: string}): Promise<Order> {
    return store.tx(async (tx) => {
      const creator = await tx.getCreator(input.creatorId);
      if (!creator) throw new ProviderError(404, 'not_found');
      const split = computeSplit(input.amountCents, creator.tier, policy);
      const order: Order = {
        id: 'ord_' + randomUUID().replaceAll('-', ''), creatorId: creator.id, amountCents: input.amountCents, currency: input.currency.toUpperCase(),
        paymentMethod: input.paymentMethod, status: 'pending', split, paymentId: null, refundedCents: 0, createdAt: new Date(),
      };
      await tx.insertOrder(order);
      await operations.prepare(tx, {
        kind: 'charge',
        subjectId: order.id,
        request: {amountCents: order.amountCents, currency: order.currency, destination: creator.payoutAccount, applicationFeeCents: split.applicationFeeCents, paymentMethod: order.paymentMethod, orderId: order.id},
      });
      return order;
    });
  }

  /** Charges the order. Safe to call again: a finished operation returns its stored result. */
  async function pay(orderId: string): Promise<Order> {
    const op = await store.tx((tx) => tx.findOperation(orderId, 'charge'));
    if (!op) throw new ProviderError(404, 'not_found');
    const outcome = await operations.execute(op.id, async (req, key) =>
      outcomeOf(
        await payments.createPayment(
          {
            amountCents: req.amountCents as number, currency: req.currency as string, destination: req.destination as string,
            applicationFeeCents: req.applicationFeeCents as number, paymentMethod: req.paymentMethod as string, orderId, operationId: op.id,
          },
          key,
        ),
      ),
    );
    return store.tx(async (tx) => applyPayment(tx, outcome.result as unknown as Payment));
  }

  /**
   * Applies a provider payment to its order after checking that it is the payment we asked for. Transitions only
   * from `pending`, so webhooks, reconciliation and the synchronous response can all call it in any order.
   */
  async function applyPayment(tx: Tx, p: Payment): Promise<Order> {
    const order = p.orderId ? await tx.getOrder(p.orderId, {forUpdate: true}) : undefined;
    if (!order) throw new ProviderError(400, 'invalid_event');
    const creator = await tx.getCreator(order.creatorId);
    const matches =
      p.amountCents === order.amountCents && p.currency.toUpperCase() === order.currency && p.applicationFeeCents === order.split.applicationFeeCents && p.destination === creator?.payoutAccount;
    if (!matches) throw new ProviderError(409, 'review_required');
    if (order.status !== 'pending' || p.status === 'processing') return order;
    if (order.paymentId && order.paymentId !== p.id) throw new ProviderError(409, 'review_required');
    if (p.status === 'failed') {
      await tx.updateOrder(order.id, {status: 'failed', paymentId: p.id});
      return {...order, status: 'failed', paymentId: p.id};
    }
    const s = order.split;
    await tx.addLedger([
      {orderId: order.id, account: 'creator:' + order.creatorId, kind: 'sale', amountCents: s.sellerNetCents},
      {orderId: order.id, account: 'platform', kind: 'commission', amountCents: s.commissionCents},
      {orderId: order.id, account: 'platform', kind: 'processing', amountCents: s.processingCents},
    ]);
    await tx.updateOrder(order.id, {status: 'paid', paymentId: p.id});
    return {...order, status: 'paid', paymentId: p.id};
  }

  /**
   * Reconciliation worker: for every charge in `unknown` (or with a dead lease), ask the provider by our own operation
   * id. Found -> record it. Not found -> the operation goes back to `prepared` and is retried with the same key.
   */
  async function reconcileDue(): Promise<{orderId: string; status: string}[]> {
    const out: {orderId: string; status: string}[] = [];
    for (const op of await operations.due('charge')) {
      let found: Payment | null = null;
      try {
        const status = await operations.reconcile(op.id, async (o) => {
          found = await payments.findByOperation(o.id);
          return found && outcomeOf(found);
        });
        if (found) await store.tx((tx) => applyPayment(tx, found!));
        else if (status === 'prepared') await pay(op.subjectId);
        const order = await store.tx((tx) => tx.getOrder(op.subjectId));
        out.push({orderId: op.subjectId, status: order?.status ?? 'missing'});
      } catch (e) {
        out.push({orderId: op.subjectId, status: 'error:' + (e instanceof ProviderError ? e.code : 'unexpected')});
      }
    }
    return out;
  }

  /** Webhook path: re-read the payment from the provider (payload is only a hint) and return the change to apply. */
  async function paymentEvent(paymentId: string): Promise<(tx: Tx) => Promise<void>> {
    const p = await payments.getPayment(paymentId);
    return async (tx) => {
      if (p.operationId) await operations.observe(tx, p.operationId, outcomeOf(p));
      await applyPayment(tx, p);
    };
  }

  /** Partial or full refund. Each refund is its own operation (`part`), so retries never refund twice. */
  async function refund(orderId: string, amountCents: number): Promise<Order> {
    const op = await store.tx(async (tx) => {
      const order = await tx.getOrder(orderId, {forUpdate: true});
      if (!order?.paymentId || !['paid', 'partially_refunded'].includes(order.status)) throw new ProviderError(409, 'conflict');
      if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || order.refundedCents + amountCents > order.amountCents) throw new ProviderError(422, 'rejected');
      let part = 0;
      while (await tx.findOperation(orderId, 'refund', part)) part++;
      return operations.prepare(tx, {kind: 'refund', subjectId: orderId, part, request: {paymentId: order.paymentId, amountCents}});
    });
    await operations.execute(op.id, async (req, key) => {
      const r = await payments.createRefund({paymentId: req.paymentId as string, amountCents: req.amountCents as number, operationId: op.id}, key);
      return {status: r.status === 'pending' ? 'pending' : r.status, result: {...r}};
    });
    return store.tx(async (tx) => {
      const order = (await tx.getOrder(orderId, {forUpdate: true}))!;
      const refunded = order.refundedCents + amountCents;
      const fee = order.split.applicationFeeCents;
      const feeBack = feeRefunded(fee, order.amountCents, refunded) - feeRefunded(fee, order.amountCents, order.refundedCents);
      const entries: LedgerEntry[] = [
        {orderId, account: 'creator:' + order.creatorId, kind: 'refund', amountCents: -(amountCents - feeBack)},
        {orderId, account: 'platform', kind: 'refund', amountCents: -feeBack},
      ];
      await tx.addLedger(entries);
      const status = refunded >= order.amountCents ? 'refunded' : 'partially_refunded';
      await tx.updateOrder(orderId, {refundedCents: refunded, status});
      return {...order, refundedCents: refunded, status};
    });
  }

  return {createOrder, pay, applyPayment, reconcileDue, paymentEvent, refund};
}

export type Marketplace = ReturnType<typeof createMarketplace>;
