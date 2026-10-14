import type {EmailAdapter, EmailMessage} from '../providers/email.ts';
import type {Operations} from './operations.ts';
import type {Store} from '../store/types.ts';

// E-mail through the same operation machinery. The outbox row is written with the business change; a worker sends
// it. The e-mail API cannot be searched by our id, so after a timeout reconciliation finds nothing and the message is
// retried with the SAME idempotency key, which the provider deduplicates inside its window.
export function createMailer({store, operations, email}: {store: Store; operations: Operations; email: EmailAdapter}) {
  async function enqueue(subjectId: string, message: EmailMessage) {
    return store.tx((tx) => operations.prepare(tx, {kind: 'email', subjectId, request: {...message}}));
  }
  async function deliver(operationId: string) {
    return operations.execute(operationId, async (req, _key, op) => {
      const {providerId} = await email.send(op.id, req as unknown as EmailMessage);
      return {status: 'succeeded', result: {providerId}};
    });
  }
  async function reconcileDue() {
    const results: string[] = [];
    for (const op of await operations.due('email')) {
      const status = await operations.reconcile(op.id, async () => null);
      if (status === 'prepared') await deliver(op.id);
      results.push(op.id);
    }
    return results;
  }
  return {enqueue, deliver, reconcileDue};
}
