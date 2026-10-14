import {createHash} from 'node:crypto';
import {ProviderError} from '../errors.ts';
import type {Store, Tx} from '../store/types.ts';
import {verifyStripeStyle} from './signature.ts';

export interface WebhookEvent {
  id: string;
  type: string;
  created: number;
  data: {object: Record<string, unknown>};
}

/**
 * A handler does its provider reads first and returns the change to apply. The change runs in the same transaction
 * that records the event id, so "event recorded" and "event applied" can never disagree.
 */
export type EventHandler = (event: WebhookEvent) => Promise<((tx: Tx) => Promise<void>) | null>;

export interface WebhookResult {
  eventId: string;
  duplicate: boolean;
  ignored: boolean;
}

export function createWebhookProcessor({
  store,
  provider,
  secrets,
  handlers,
  now = () => Date.now(),
}: {
  store: Store;
  provider: string;
  /** Current secrets, newest first. Two are active while a secret is being rotated. */
  secrets: () => readonly string[];
  handlers: Record<string, EventHandler>;
  now?: () => number;
}) {
  return async function handle(raw: Buffer, signatureHeader: string | null): Promise<WebhookResult> {
    // 1. Authenticity on the exact bytes received, before parsing anything.
    if (!verifyStripeStyle(raw, signatureHeader, secrets(), now())) throw new ProviderError(400, 'invalid_signature');
    let event: WebhookEvent;
    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new ProviderError(400, 'bad_payload');
    }
    if (typeof event?.id !== 'string' || !/^evt_[A-Za-z0-9]{1,180}$/.test(event.id) || typeof event.type !== 'string' || !Number.isSafeInteger(event.created)) {
      throw new ProviderError(400, 'invalid_event');
    }
    // 2. Cheap early exit for redeliveries (the authoritative check is the insert below).
    if (await store.tx((tx) => tx.hasEvent(provider, event.id))) return {eventId: event.id, duplicate: true, ignored: false};
    // 3. Provider reads outside the transaction.
    const handler = handlers[event.type];
    const apply = handler ? await handler(event) : null;
    // 4. Record + apply atomically. A concurrent delivery of the same event loses the insert and does nothing.
    const digest = createHash('sha256').update(raw).digest('hex');
    return store.tx(async (tx) => {
      if (!(await tx.insertEvent(provider, event.id, digest))) return {eventId: event.id, duplicate: true, ignored: false};
      if (apply) await apply(tx);
      return {eventId: event.id, duplicate: false, ignored: !apply};
    });
  };
}
