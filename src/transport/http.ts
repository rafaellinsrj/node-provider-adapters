import type {Transport} from './types.ts';

// Real HTTP. Redirects are refused (a provider API never needs one, and following one could leak the Authorization
// header to another host) and every call has a hard timeout.
export function fetchTransport({timeoutMs = 10_000}: {timeoutMs?: number} = {}): Transport {
  return async (url, init) => {
    const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    const res = await fetch(url, {method: init.method, headers: init.headers, body: init.body, signal, redirect: 'error'});
    return {status: res.status, headers: res.headers, text: () => res.text()};
  };
}
