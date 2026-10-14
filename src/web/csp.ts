import {randomBytes} from 'node:crypto';

/** 128+ bits from a CSPRNG, fresh for every response. A reused nonce is as good as 'unsafe-inline'. */
export const newNonce = () => randomBytes(18).toString('base64');

export interface ThirdParty {
  /** Script origins allowed for this response only (e.g. an analytics tag the visitor consented to). */
  scriptOrigins?: string[];
  connectOrigins?: string[];
}

// Strict policy: scripts and styles only from our origin or carrying this response's nonce. No 'unsafe-inline',
// no 'unsafe-eval', no 'strict-dynamic' (so a consented third-party script cannot pull in arbitrary hosts).
export function contentSecurityPolicy(nonce: string, third: ThirdParty = {}): string {
  if (!/^[A-Za-z0-9+/=]{16,}$/.test(nonce)) throw new Error('invalid nonce');
  return [
    "default-src 'self'",
    ["script-src 'self'", `'nonce-${nonce}'`, ...(third.scriptOrigins ?? [])].join(' '),
    `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'none'",
    "img-src 'self' data: https:",
    ["connect-src 'self'", ...(third.connectOrigins ?? [])].join(' '),
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}
