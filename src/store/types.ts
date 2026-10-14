import type {Split} from '../marketplace/split.ts';

export type OperationStatus = 'prepared' | 'running' | 'succeeded' | 'failed' | 'unknown' | 'blocked';

/** Intent record written BEFORE calling a provider (outbox). Its id is the idempotency key. */
export interface Operation {
  id: string;
  kind: string;
  /** What the operation is about (an order, an outbox message...). */
  subjectId: string;
  /** Several operations of one kind on the same subject (e.g. partial refunds). */
  part: number;
  status: OperationStatus;
  request: Record<string, unknown>;
  result: Record<string, unknown> | null;
  /** Digest of the provider account/config used. A new account means old idempotency keys mean nothing. */
  configDigest: string;
  attempts: number;
  firstAttemptAt: Date | null;
  availableAt: Date;
  leaseToken: string | null;
  leaseUntil: Date | null;
  errorCode: string | null;
  updatedAt: Date;
}

export interface Creator {
  id: string;
  tier: string;
  /** Connected account at the payment provider that receives payouts. */
  payoutAccount: string;
}

export type OrderStatus = 'pending' | 'paid' | 'failed' | 'partially_refunded' | 'refunded';
export interface Order {
  id: string;
  creatorId: string;
  amountCents: number;
  currency: string;
  paymentMethod: string;
  status: OrderStatus;
  split: Split;
  paymentId: string | null;
  refundedCents: number;
  createdAt: Date;
}

export interface LedgerEntry {
  orderId: string;
  account: string;
  kind: 'sale' | 'commission' | 'processing' | 'refund';
  amountCents: number;
}

export interface Tx {
  getOperation(id: string, opts?: {forUpdate?: boolean}): Promise<Operation | undefined>;
  findOperation(subjectId: string, kind: string, part?: number): Promise<Operation | undefined>;
  /** Insert unless (subjectId, kind, part) exists. Returns true when inserted. */
  insertOperation(op: Operation): Promise<boolean>;
  updateOperation(id: string, patch: Partial<Operation>): Promise<void>;
  dueOperations(kind: string, now: Date, limit: number): Promise<Operation[]>;
  /** Insert unless (provider, eventId) exists. Returns true when inserted. */
  insertEvent(provider: string, eventId: string, digest: string): Promise<boolean>;
  hasEvent(provider: string, eventId: string): Promise<boolean>;
  putCreator(c: Creator): Promise<void>;
  getCreator(id: string): Promise<Creator | undefined>;
  insertOrder(o: Order): Promise<void>;
  getOrder(id: string, opts?: {forUpdate?: boolean}): Promise<Order | undefined>;
  updateOrder(id: string, patch: Partial<Order>): Promise<void>;
  addLedger(entries: LedgerEntry[]): Promise<void>;
  ledger(orderId?: string): Promise<LedgerEntry[]>;
}

export interface Store {
  /** Runs `fn` atomically: everything or nothing. */
  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}
