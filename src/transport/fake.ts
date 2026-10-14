import type {Transport, TransportRequest, TransportResponse} from './types.ts';

export interface FakeRequest {
  method: TransportRequest['method'];
  url: URL;
  headers: Record<string, string>;
  body: string;
}
export interface FakeReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}
export type FakeHandler = (req: FakeRequest) => FakeReply | Promise<FakeReply>;

/**
 * Fault injected into the next matching call:
 * - `timeout-before`: the request never reaches the provider, then the client times out.
 * - `timeout-after`: the provider processes the request, but the response is lost (the dangerous case).
 * - `status`: the provider answers with this HTTP status without processing.
 */
export type Fault = {kind: 'timeout-before' | 'timeout-after'} | {kind: 'status'; status: number; body?: unknown};

export interface FakeTransport extends Transport {
  calls: FakeRequest[];
  failNext(match: (req: FakeRequest) => boolean, fault: Fault): void;
}

export const reply = (status: number, body: unknown, headers: Record<string, string> = {}): TransportResponse => ({
  status,
  headers: new Headers({'content-type': 'application/json', ...headers}),
  text: async () => JSON.stringify(body),
});

const timeoutError = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');

// Deterministic in-process transport: the handler plays the provider. No sockets, no keys, no clock.
export function fakeTransport(handler: FakeHandler): FakeTransport {
  const faults: {match: (req: FakeRequest) => boolean; fault: Fault}[] = [];
  const calls: FakeRequest[] = [];
  const transport = (async (url, init) => {
    const req: FakeRequest = {method: init.method, url: new URL(url), headers: lower(init.headers), body: init.body ?? ''};
    calls.push(req);
    const index = faults.findIndex((f) => f.match(req));
    const fault = index >= 0 ? faults.splice(index, 1)[0]!.fault : null;
    if (fault?.kind === 'timeout-before') throw timeoutError();
    if (fault?.kind === 'status') return reply(fault.status, fault.body ?? {error: {type: 'api_error'}});
    const out = await handler(req);
    if (fault?.kind === 'timeout-after') throw timeoutError();
    return reply(out.status, out.body, out.headers);
  }) as FakeTransport;
  transport.calls = calls;
  transport.failNext = (match, fault) => void faults.push({match, fault});
  return transport;
}

export const lower = (headers: Record<string, string>) => Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
