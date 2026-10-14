// Consent is stored in a first-party cookie the server can read, so the server decides what each response may load:
// without consent, the third-party tag is neither in the HTML nor allowed by the CSP. Two independent locks.
export const CONSENT_COOKIE = 'consent';
export const CONSENT_VERSION = 1;
export const CONSENT_MAX_AGE_DAYS = 365;

export interface Consent {
  measurement: boolean;
  marketing: boolean;
}
export const NO_CONSENT: Consent = Object.freeze({measurement: false, marketing: false});

/** Format: `v1.m1.k0` (version, measurement, marketing). Anything else, or an old version, means "ask again". */
export function parseConsent(cookieHeader: string | null | undefined): Consent | null {
  const raw = (cookieHeader ?? '')
    .split(';')
    .map((p) => p.trim())
    .find((p) => p.startsWith(CONSENT_COOKIE + '='))
    ?.slice(CONSENT_COOKIE.length + 1);
  const m = /^v(\d+)\.m([01])\.k([01])$/.exec(raw ?? '');
  if (!m || Number(m[1]) !== CONSENT_VERSION) return null;
  return {measurement: m[2] === '1', marketing: m[3] === '1'};
}

export function consentCookie(c: Consent, {secure = true} = {}): string {
  const value = `v${CONSENT_VERSION}.m${c.measurement ? 1 : 0}.k${c.marketing ? 1 : 0}`;
  return `${CONSENT_COOKIE}=${value}; Path=/; Max-Age=${CONSENT_MAX_AGE_DAYS * 86400}; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export interface ThirdPartyScript {
  purpose: keyof Consent;
  src: string;
}

/** Scripts this response may load, given the visitor's choice. No choice = nothing. */
export const allowedScripts = (consent: Consent | null, scripts: readonly ThirdPartyScript[]) => scripts.filter((s) => consent?.[s.purpose] === true);
