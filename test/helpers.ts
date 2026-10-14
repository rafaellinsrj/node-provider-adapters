import {randomBytes} from 'node:crypto';
import {fakePaymentsProvider} from '../src/fakes/payments-provider.ts';
import {createMarketplace} from '../src/marketplace/orders.ts';
import {createOperations} from '../src/operations/operations.ts';
import {stripeLikePayments} from '../src/providers/payments.ts';
import {memoryStore} from '../src/store/memory.ts';
import type {Store} from '../src/store/types.ts';
import {fakeTransport} from '../src/transport/fake.ts';

/** Obviously fake, generated per run. Never a real credential. */
export const fakeSecret = (prefix: string) => `${prefix}_FAKE${randomBytes(12).toString('hex')}`;

export function clock(start = Date.parse('2030-01-01T12:00:00Z')) {
  let t = start;
  return {now: () => new Date(t), advance: (ms: number) => void (t += ms)};
}

export async function world({store = memoryStore()}: {store?: Store} = {}) {
  const apiKey = fakeSecret('sk_test');
  const provider = fakePaymentsProvider({apiKey});
  const transport = fakeTransport(provider.handler);
  const payments = stripeLikePayments({apiKey, transport});
  const time = clock(Date.now());
  const operations = createOperations(store, {configDigest: 'cfg-1', now: time.now});
  const market = createMarketplace({store, payments, operations});
  provider.addAccount('acct_creatorA');
  await store.tx((tx) => tx.putCreator({id: 'creator-a', tier: 'basic', payoutAccount: 'acct_creatorA'}));
  return {store, provider, transport, payments, operations, market, time, apiKey};
}

export const isPaymentCreate = (r: {method: string; url: URL}) => r.method === 'POST' && r.url.pathname === '/v1/payment_intents';
