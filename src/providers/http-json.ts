import {ProviderError} from '../errors.ts';
import type {Transport, TransportRequest} from '../transport/types.ts';

// Shared response classification for JSON provider APIs. The rule that matters: a failed MUTATION is
// `outcome_unknown` (the provider may have applied it), a failed READ is just `unavailable`.
export async function callJson(
  transport: Transport,
  url: string,
  init: TransportRequest,
  {mutation}: {mutation: boolean},
): Promise<{status: number; body: Record<string, unknown>; headers: Headers}> {
  const uncertain = () => new ProviderError(503, mutation ? 'outcome_unknown' : 'unavailable');
  let res;
  try {
    res = await transport(url, init);
  } catch {
    // Timeout, reset, DNS... the request may have been delivered.
    throw uncertain();
  }
  let body: unknown;
  try {
    body = JSON.parse(await res.text());
  } catch {
    throw uncertain();
  }
  if (!body || typeof body !== 'object') throw uncertain();
  if (res.status === 429 || res.status === 409) {
    const error = new ProviderError(503, 'rate_limited');
    const retry = Number(res.headers.get('retry-after'));
    error.retryAfterSeconds = Number.isFinite(retry) && retry > 0 ? Math.min(3600, retry) : 60;
    throw error;
  }
  if (res.status >= 500) throw uncertain();
  return {status: res.status, body: body as Record<string, unknown>, headers: res.headers};
}

export interface PauseSwitch {
  isPaused(provider: string): boolean | Promise<boolean>;
}
export const neverPaused: PauseSwitch = {isPaused: () => false};

export async function assertRunning(pause: PauseSwitch, provider: string) {
  if (await pause.isPaused(provider)) throw new ProviderError(503, 'provider_paused');
}
