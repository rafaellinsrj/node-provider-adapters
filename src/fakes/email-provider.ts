import {randomUUID} from 'node:crypto';
import type {FakeHandler} from '../transport/fake.ts';

// Resend-shaped fake: one e-mail per idempotency key, whatever the number of attempts.
export function fakeEmailProvider({apiKey}: {apiKey: string}) {
  const byKey = new Map<string, string>();
  const sent: {id: string; to: string; subject: string}[] = [];
  const handler: FakeHandler = (req) => {
    if (req.headers.authorization !== `Bearer ${apiKey}`) return {status: 401, body: {name: 'validation_error'}};
    const key = req.headers['idempotency-key'];
    if (key && byKey.has(key)) return {status: 200, body: {id: byKey.get(key)}};
    const msg = JSON.parse(req.body) as {to: string; subject: string};
    const id = randomUUID();
    if (key) byKey.set(key, id);
    sent.push({id, to: msg.to, subject: msg.subject});
    return {status: 200, body: {id}};
  };
  return {handler, sent};
}
