import {createHmac, timingSafeEqual} from 'node:crypto';

export const TOLERANCE_SECONDS = 300;

const safeEqualHex = (a: string, b: string) => {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
};

/**
 * Stripe-style header: `t=<unix seconds>,v1=<hex hmac>[,v1=<hex hmac>...]`, where the HMAC-SHA256 covers
 * `${t}.${rawBody}`. Several `v1` entries appear while the provider rolls a secret; several local secrets are accepted
 * while we roll ours. Signing the timestamp is what makes the tolerance window meaningful against replays.
 */
export function verifyStripeStyle(raw: Buffer, header: string | null, secrets: readonly string[], now = Date.now()): boolean {
  if (typeof header !== 'string' || header.length > 2000 || !secrets.length) return false;
  const parts = header.split(',').map((p) => p.trim());
  const stamp = parts.find((p) => p.startsWith('t='))?.slice(2) ?? '';
  if (!/^\d{1,12}$/.test(stamp) || Math.abs(now / 1000 - Number(stamp)) > TOLERANCE_SECONDS) return false;
  const candidates = parts.filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  return secrets.some((secret) => {
    const expected = createHmac('sha256', secret).update(stamp + '.').update(raw).digest('hex');
    return candidates.some((c) => safeEqualHex(expected, c));
  });
}

/** Test/fake helper: produces the header the provider would send. */
export function signStripeStyle(raw: Buffer | string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const sig = createHmac('sha256', secret).update(timestamp + '.').update(raw).digest('hex');
  return `t=${timestamp},v1=${sig}`;
}

/**
 * Hex HMAC of the raw body with the timestamp in a separate header (used by some KYC providers). The timestamp is NOT
 * covered by the signature in this scheme, so the window alone does not stop replays: deduplicate by event id too.
 */
export function verifyHexHmac(raw: Buffer, signature: string | null, timestamp: string | null, secrets: readonly string[], now = Date.now()): boolean {
  const stamp = Number(timestamp);
  if (!/^[a-f0-9]{64}$/.test(signature ?? '') || !Number.isSafeInteger(stamp) || Math.abs(now / 1000 - stamp) > TOLERANCE_SECONDS) return false;
  return secrets.some((s) => safeEqualHex(createHmac('sha256', s).update(raw).digest('hex'), signature!));
}
