// Every failure that crosses a module boundary is a ProviderError with a short, stable code. Business code branches on
// the code, never on provider messages (they may contain personal data and change without notice).
export type ErrorCode =
  // The request may or may not have taken effect at the provider: never assume either way.
  | 'outcome_unknown'
  // A read failed or the provider is down; safe to retry later.
  | 'unavailable'
  | 'rate_limited'
  // The provider answered with a definitive refusal (4xx). Retrying the same request will not help.
  | 'rejected'
  | 'invalid_result'
  | 'not_configured'
  | 'provider_paused'
  | 'path_denied'
  | 'invalid_signature'
  | 'invalid_event'
  | 'bad_payload'
  | 'not_found'
  | 'conflict'
  | 'operation_in_progress'
  | 'retry_later'
  | 'reconciliation_required'
  | 'review_required'
  | 'configuration_changed';

export class ProviderError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  retryAfterSeconds?: number;
  constructor(status: number, code: ErrorCode) {
    super(code);
    this.name = 'ProviderError';
    this.status = status;
    this.code = code;
  }
}

/** Codes that mean "we do not know what happened"; the caller must reconcile, not decide. */
export const UNCERTAIN: ReadonlySet<ErrorCode> = new Set(['outcome_unknown', 'unavailable', 'rate_limited', 'invalid_result']);

export const isProviderError = (e: unknown): e is ProviderError => e instanceof ProviderError;
