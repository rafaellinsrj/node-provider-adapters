import {randomUUID} from 'node:crypto';
import {ProviderError, UNCERTAIN} from '../errors.ts';
import type {Operation, OperationStatus, Store, Tx} from '../store/types.ts';

// Providers prune idempotency keys after about 24 h. Past this window, replaying an uncertain call could execute it
// twice, so the operation is blocked for a human instead.
export const SAFE_REPLAY_MS = 23 * 3600_000;
export const MAX_ATTEMPTS = 8;
const LEASE_MS = 60_000;

export type Outcome = {status: 'succeeded' | 'failed' | 'pending'; result: Record<string, unknown>};
export type Perform = (request: Record<string, unknown>, idempotencyKey: string, op: Operation) => Promise<Outcome>;
/** Asks the provider what really happened. `null` = the provider has no object for this operation. */
export type Lookup = (op: Operation) => Promise<Outcome | null>;

export interface OperationsOptions {
  /** Digest of the provider account/config in use (e.g. HMAC of the API key). */
  configDigest: string;
  now?: () => Date;
}

export type Operations = ReturnType<typeof createOperations>;

/**
 * Provider calls as a small state machine persisted BEFORE the call:
 *
 *   prepared -> running -> succeeded | failed            (definitive answers)
 *                       -> unknown                       (timeout, 5xx, garbage: the call may have happened)
 *   unknown  -> reconcile(): ask the provider -> succeeded | failed
 *                            nothing found, within the key window -> prepared (retry with the SAME key)
 *                            nothing found, too old             -> blocked (human review)
 */
export function createOperations(store: Store, {configDigest, now = () => new Date()}: OperationsOptions) {
  const keyOf = (op: Operation) => 'op-' + op.id;

  /** Writes the intent inside the caller's transaction (same commit as the business row = transactional outbox). */
  async function prepare(tx: Tx, input: {kind: string; subjectId: string; part?: number; request: Record<string, unknown>}): Promise<Operation> {
    const part = input.part ?? 0;
    const op: Operation = {
      id: randomUUID(), kind: input.kind, subjectId: input.subjectId, part, status: 'prepared', request: input.request, result: null,
      configDigest, attempts: 0, firstAttemptAt: null, availableAt: now(), leaseToken: null, leaseUntil: null, errorCode: null, updatedAt: now(),
    };
    await tx.insertOperation(op);
    // On conflict the existing row wins: preparing twice yields the same operation and the same key.
    return (await tx.findOperation(input.subjectId, input.kind, part))!;
  }

  async function execute(id: string, perform: Perform): Promise<Outcome> {
    const lease = randomUUID();
    const claimed = await store.tx(async (tx) => {
      const op = await tx.getOperation(id, {forUpdate: true});
      if (!op) throw new ProviderError(404, 'not_found');
      if (op.configDigest !== configDigest) throw new ProviderError(409, 'configuration_changed');
      if (op.status === 'succeeded' || op.status === 'failed') return {cached: true as const, op};
      if (op.status === 'blocked') throw new ProviderError(409, 'review_required');
      // Never "just retry" an uncertain call: find out first.
      if (op.status === 'unknown') throw new ProviderError(409, 'reconciliation_required');
      if (op.status === 'running') {
        if (op.leaseUntil && op.leaseUntil > now()) throw new ProviderError(409, 'operation_in_progress');
        // The worker that held the lease died mid-call: same situation as a timeout.
        throw new ProviderError(409, 'reconciliation_required');
      }
      if (op.availableAt > now()) throw new ProviderError(429, 'retry_later');
      const patch = {status: 'running' as const, leaseToken: lease, leaseUntil: new Date(now().getTime() + LEASE_MS), attempts: op.attempts + 1, firstAttemptAt: op.firstAttemptAt ?? now()};
      await tx.updateOperation(id, patch);
      return {cached: false as const, op: {...op, ...patch}, previous: op};
    });
    if (claimed.cached) return {status: claimed.op.status as 'succeeded' | 'failed', result: claimed.op.result ?? {}};

    const {op, previous} = claimed;
    let outcome: Outcome;
    try {
      outcome = await perform(op.request, keyOf(op), op);
    } catch (e) {
      const code = e instanceof ProviderError ? e.code : 'outcome_unknown';
      await store.tx(async (tx) => {
        const current = await tx.getOperation(id, {forUpdate: true});
        if (current?.leaseToken !== lease) return;
        if (code === 'provider_paused') {
          // The kill switch fired before any request left: undo the claim, keep the same key for later.
          await tx.updateOperation(id, {status: previous.status, attempts: previous.attempts, firstAttemptAt: previous.firstAttemptAt, leaseToken: null, leaseUntil: null});
          return;
        }
        const status: OperationStatus = UNCERTAIN.has(code) ? 'unknown' : 'blocked';
        const backoff = Math.min(300, 2 ** Math.min(op.attempts, 8)) * 1000;
        await tx.updateOperation(id, {status, errorCode: code, leaseToken: null, leaseUntil: null, availableAt: new Date(now().getTime() + backoff)});
      });
      throw e;
    }
    await store.tx(async (tx) => {
      const current = await tx.getOperation(id, {forUpdate: true});
      if (current?.leaseToken !== lease || current.status !== 'running') throw new ProviderError(409, 'operation_in_progress');
      await tx.updateOperation(id, finalPatch(outcome, now()));
    });
    return outcome;
  }

  /** Records what the provider says (webhook or reconciliation). A late or stale answer never undoes a success. */
  async function observe(tx: Tx, id: string, outcome: Outcome): Promise<Operation | undefined> {
    const op = await tx.getOperation(id, {forUpdate: true});
    if (!op || op.status === 'succeeded') return op;
    const patch = finalPatch(outcome, now());
    await tx.updateOperation(id, patch);
    return {...op, ...patch};
  }

  async function reconcile(id: string, lookup: Lookup): Promise<OperationStatus> {
    const op = await store.tx((tx) => tx.getOperation(id));
    if (!op) throw new ProviderError(404, 'not_found');
    const stale = op.status === 'running' && op.leaseUntil !== null && op.leaseUntil <= now();
    if (op.status !== 'unknown' && !stale) return op.status;
    const found = await lookup(op);
    return store.tx(async (tx) => {
      const current = await tx.getOperation(id, {forUpdate: true});
      if (!current || current.updatedAt.getTime() !== op.updatedAt.getTime()) return current?.status ?? 'blocked';
      if (found) return (await observe(tx, id, found))!.status;
      const age = current.firstAttemptAt ? now().getTime() - current.firstAttemptAt.getTime() : 0;
      if (age < SAFE_REPLAY_MS && current.attempts < MAX_ATTEMPTS) {
        // The provider has no trace of it and the key is still honoured: retrying with the same key is safe.
        await tx.updateOperation(id, {status: 'prepared', leaseToken: null, leaseUntil: null, availableAt: now()});
        return 'prepared';
      }
      await tx.updateOperation(id, {status: 'blocked', errorCode: 'review_required', leaseToken: null, leaseUntil: null});
      return 'blocked';
    });
  }

  const due = (kind: string, limit = 50) => store.tx((tx) => tx.dueOperations(kind, now(), limit));

  return {prepare, execute, observe, reconcile, due, keyOf};
}

function finalPatch(outcome: Outcome, at: Date): Partial<Operation> {
  // `pending` (e.g. an async payment method) is parked as unknown and settled by reconciliation or a webhook.
  const status: OperationStatus = outcome.status === 'pending' ? 'unknown' : outcome.status;
  return {status, result: outcome.result, errorCode: null, leaseToken: null, leaseUntil: null, availableAt: new Date(at.getTime() + (status === 'unknown' ? 30_000 : 0))};
}
