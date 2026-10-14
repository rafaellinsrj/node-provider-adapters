import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {postgresStore} from '../src/store/postgres.ts';
import {isPaymentCreate, world} from './helpers.ts';

// Runs only when DATABASE_URL points to a disposable database (CI provides one). Uses its own schema.
const url = process.env.DATABASE_URL;

test('PostgreSQL store: timeout -> unknown -> reconciliation -> paid once', {skip: !url && 'DATABASE_URL not set'}, async () => {
  const {default: pg} = await import('pg');
  const schema = 'npa_' + Date.now();
  const pool = new pg.Pool({connectionString: url, options: `-c search_path=${schema}`});
  await pool.query(`CREATE SCHEMA ${schema}`);
  await pool.query(await readFile(new URL('../migrations/001_init.sql', import.meta.url), 'utf8'));
  try {
    const w = await world({store: postgresStore(pool)});
    const order = await w.market.createOrder({creatorId: 'creator-a', amountCents: 8000, currency: 'usd', paymentMethod: 'pm_card_ok'});
    w.transport.failNext(isPaymentCreate, {kind: 'timeout-after'});
    await assert.rejects(w.market.pay(order.id));
    w.time.advance(5 * 60_000);
    assert.deepEqual(await w.market.reconcileDue(), [{orderId: order.id, status: 'paid'}]);
    const op = await w.store.tx((tx) => tx.findOperation(order.id, 'charge'));
    assert.equal(w.provider.countFor(op!.id), 1);
    assert.equal((await w.store.tx((tx) => tx.ledger(order.id))).reduce((s, e) => s + e.amountCents, 0), 8000);
  } finally {
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.end();
  }
});
