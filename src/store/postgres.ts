import type pg from 'pg';
import type {Creator, LedgerEntry, Operation, Order, Store, Tx} from './types.ts';

// PostgreSQL store. Same contract as memoryStore; row locks (FOR UPDATE) replace the in-memory single writer.
// Pass a pg.Pool; run migrations/001_init.sql first.
export function postgresStore(pool: pg.Pool): Store {
  return {
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(bind(client));
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

const OP_COLUMNS: Record<keyof Operation, string> = {
  id: 'id', kind: 'kind', subjectId: 'subject_id', part: 'part', status: 'status', request: 'request', result: 'result',
  configDigest: 'config_digest', attempts: 'attempts', firstAttemptAt: 'first_attempt_at', availableAt: 'available_at',
  leaseToken: 'lease_token', leaseUntil: 'lease_until', errorCode: 'error_code', updatedAt: 'updated_at',
};
const ORDER_COLUMNS: Record<keyof Order, string> = {
  id: 'id', creatorId: 'creator_id', amountCents: 'amount_cents', currency: 'currency', paymentMethod: 'payment_method',
  status: 'status', split: 'split', paymentId: 'payment_id', refundedCents: 'refunded_cents', createdAt: 'created_at',
};

type Row = Record<string, unknown>;
const toOperation = (r: Row): Operation => ({
  id: r.id as string, kind: r.kind as string, subjectId: r.subject_id as string, part: r.part as number,
  status: r.status as Operation['status'], request: r.request as Operation['request'], result: (r.result ?? null) as Operation['result'],
  configDigest: r.config_digest as string, attempts: r.attempts as number, firstAttemptAt: (r.first_attempt_at ?? null) as Date | null,
  availableAt: r.available_at as Date, leaseToken: (r.lease_token ?? null) as string | null, leaseUntil: (r.lease_until ?? null) as Date | null,
  errorCode: (r.error_code ?? null) as string | null, updatedAt: r.updated_at as Date,
});
const toOrder = (r: Row): Order => ({
  id: r.id as string, creatorId: r.creator_id as string, amountCents: Number(r.amount_cents), currency: r.currency as string,
  paymentMethod: r.payment_method as string, status: r.status as Order['status'], split: r.split as Order['split'],
  paymentId: (r.payment_id ?? null) as string | null, refundedCents: Number(r.refunded_cents), createdAt: r.created_at as Date,
});
const json = (v: unknown) => (v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v);

function update(table: string, columns: Record<string, string>, id: string, patch: Record<string, unknown>, extra = '') {
  const keys = Object.keys(patch).filter((k) => k in columns && k !== 'id');
  const sets = keys.map((k, i) => `${columns[k]} = $${i + 2}`);
  return {text: `UPDATE ${table} SET ${[...sets, extra].filter(Boolean).join(', ')} WHERE id = $1`, values: [id, ...keys.map((k) => json(patch[k]))]};
}

function bind(c: pg.PoolClient): Tx {
  const one = async (text: string, values: unknown[]) => (await c.query(text, values)).rows[0] as Row | undefined;
  return {
    async getOperation(id, opts) {
      const r = await one(`SELECT * FROM provider_operations WHERE id = $1${opts?.forUpdate ? ' FOR UPDATE' : ''}`, [id]);
      return r && toOperation(r);
    },
    async findOperation(subjectId, kind, part = 0) {
      const r = await one('SELECT * FROM provider_operations WHERE subject_id = $1 AND kind = $2 AND part = $3', [subjectId, kind, part]);
      return r && toOperation(r);
    },
    async insertOperation(o) {
      const res = await c.query(
        `INSERT INTO provider_operations (id, kind, subject_id, part, status, request, result, config_digest, attempts, first_attempt_at, available_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (subject_id, kind, part) DO NOTHING`,
        [o.id, o.kind, o.subjectId, o.part, o.status, JSON.stringify(o.request), o.result && JSON.stringify(o.result), o.configDigest, o.attempts, o.firstAttemptAt, o.availableAt],
      );
      return res.rowCount === 1;
    },
    async updateOperation(id, patch) {
      await c.query(update('provider_operations', OP_COLUMNS, id, patch, 'updated_at = now()'));
    },
    async dueOperations(kind, now, limit) {
      const res = await c.query(
        `SELECT * FROM provider_operations WHERE kind = $1
           AND ((status = 'unknown' AND available_at <= $2) OR (status = 'running' AND lease_until <= $2))
         ORDER BY available_at LIMIT $3 FOR UPDATE SKIP LOCKED`,
        [kind, now, limit],
      );
      return res.rows.map(toOperation);
    },
    async insertEvent(provider, eventId, digest) {
      const res = await c.query('INSERT INTO provider_events (provider, event_id, payload_digest) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [provider, eventId, digest]);
      return res.rowCount === 1;
    },
    hasEvent: async (provider, eventId) => !!(await one('SELECT 1 FROM provider_events WHERE provider = $1 AND event_id = $2', [provider, eventId])),
    async putCreator(cr: Creator) {
      await c.query('INSERT INTO creators (id, tier, payout_account) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET tier = $2, payout_account = $3', [cr.id, cr.tier, cr.payoutAccount]);
    },
    async getCreator(id) {
      const r = await one('SELECT * FROM creators WHERE id = $1', [id]);
      return r && {id: r.id as string, tier: r.tier as string, payoutAccount: r.payout_account as string};
    },
    async insertOrder(o) {
      await c.query(
        'INSERT INTO orders (id, creator_id, amount_cents, currency, payment_method, status, split, payment_id, refunded_cents, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [o.id, o.creatorId, o.amountCents, o.currency, o.paymentMethod, o.status, JSON.stringify(o.split), o.paymentId, o.refundedCents, o.createdAt],
      );
    },
    async getOrder(id, opts) {
      const r = await one(`SELECT * FROM orders WHERE id = $1${opts?.forUpdate ? ' FOR UPDATE' : ''}`, [id]);
      return r && toOrder(r);
    },
    async updateOrder(id, patch) {
      await c.query(update('orders', ORDER_COLUMNS, id, patch));
    },
    async addLedger(entries: LedgerEntry[]) {
      for (const e of entries) await c.query('INSERT INTO ledger_entries (order_id, account, kind, amount_cents) VALUES ($1,$2,$3,$4)', [e.orderId, e.account, e.kind, e.amountCents]);
    },
    async ledger(orderId) {
      const res = await c.query(`SELECT order_id, account, kind, amount_cents FROM ledger_entries${orderId ? ' WHERE order_id = $1' : ''} ORDER BY id`, orderId ? [orderId] : []);
      return res.rows.map((r) => ({orderId: r.order_id, account: r.account, kind: r.kind, amountCents: Number(r.amount_cents)}));
    },
  };
}
