import type {Creator, LedgerEntry, Operation, Order, Store, Tx} from './types.ts';

interface State {
  operations: Map<string, Operation>;
  events: Map<string, string>;
  creators: Map<string, Creator>;
  orders: Map<string, Order>;
  ledger: LedgerEntry[];
}

// In-memory store with the same contract as the PostgreSQL one: transactions are serialized (a single writer, like
// SELECT ... FOR UPDATE on every row) and roll back on error by restoring a snapshot.
export function memoryStore(): Store {
  let state: State = {operations: new Map(), events: new Map(), creators: new Map(), orders: new Map(), ledger: []};
  let queue: Promise<unknown> = Promise.resolve();

  const tx: Tx = {
    getOperation: async (id) => clone(state.operations.get(id)),
    findOperation: async (subjectId, kind, part = 0) => clone([...state.operations.values()].find((o) => o.subjectId === subjectId && o.kind === kind && o.part === part)),
    async insertOperation(op) {
      if ([...state.operations.values()].some((o) => o.subjectId === op.subjectId && o.kind === op.kind && o.part === op.part)) return false;
      state.operations.set(op.id, clone(op)!);
      return true;
    },
    async updateOperation(id, patch) {
      const op = state.operations.get(id);
      if (op) state.operations.set(id, {...op, ...clone(patch), updatedAt: new Date()});
    },
    dueOperations: async (kind, now, limit) =>
      [...state.operations.values()]
        .filter((o) => o.kind === kind && ((o.status === 'unknown' && o.availableAt <= now) || (o.status === 'running' && o.leaseUntil !== null && o.leaseUntil <= now)))
        .slice(0, limit)
        .map((o) => clone(o)!),
    async insertEvent(provider, eventId, digest) {
      const key = provider + ':' + eventId;
      if (state.events.has(key)) return false;
      state.events.set(key, digest);
      return true;
    },
    hasEvent: async (provider, eventId) => state.events.has(provider + ':' + eventId),
    putCreator: async (c) => void state.creators.set(c.id, clone(c)!),
    getCreator: async (id) => clone(state.creators.get(id)),
    insertOrder: async (o) => {
      if (state.orders.has(o.id)) throw new Error('duplicate order');
      state.orders.set(o.id, clone(o)!);
    },
    getOrder: async (id) => clone(state.orders.get(id)),
    async updateOrder(id, patch) {
      const o = state.orders.get(id);
      if (o) state.orders.set(id, {...o, ...clone(patch)});
    },
    addLedger: async (entries) => void state.ledger.push(...clone(entries)!),
    ledger: async (orderId) => clone(state.ledger.filter((e) => !orderId || e.orderId === orderId))!,
  };

  return {
    tx<T>(fn: (t: Tx) => Promise<T>): Promise<T> {
      const run = queue.then(async () => {
        const snapshot = structuredClone(state);
        try {
          return await fn(tx);
        } catch (e) {
          state = snapshot;
          throw e;
        }
      });
      queue = run.catch(() => undefined);
      return run;
    },
  };
}

const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));
