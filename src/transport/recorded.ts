import type {Transport} from './types.ts';
import {lower, reply} from './fake.ts';

// Cassettes: record a session once (against a sandbox or a fake) and replay it in tests. Secrets never reach the file:
// authorization-like headers are dropped at record time.
export interface Interaction {
  method: string;
  url: string;
  idempotencyKey?: string;
  body: string;
  status: number;
  response: unknown;
}

const SECRET_HEADERS = /^(authorization|x-api-key|cookie)$/i;

export function recordingTransport(inner: Transport, cassette: Interaction[]): Transport {
  return async (url, init) => {
    const res = await inner(url, init);
    const text = await res.text();
    const headers = lower(init.headers);
    for (const key of Object.keys(headers)) if (SECRET_HEADERS.test(key)) delete headers[key];
    cassette.push({method: init.method, url, idempotencyKey: headers['idempotency-key'], body: init.body ?? '', status: res.status, response: JSON.parse(text)});
    return {status: res.status, headers: res.headers, text: async () => text};
  };
}

// Strict replay: interactions must happen in the same order with the same method, URL and body. Any drift fails the
// test loudly instead of silently hitting the network.
export function replayTransport(cassette: readonly Interaction[]): Transport {
  let position = 0;
  return async (url, init) => {
    const next = cassette[position++];
    if (!next || next.method !== init.method || next.url !== url || next.body !== (init.body ?? '')) {
      throw new Error(`cassette mismatch at #${position - 1}: ${init.method} ${url}`);
    }
    return reply(next.status, next.response);
  };
}
