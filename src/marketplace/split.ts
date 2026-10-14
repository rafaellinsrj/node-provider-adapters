// Marketplace split with the commission charged INSIDE the buyer's payment (destination charge + application fee):
// the provider moves the gross to the seller's account and keeps `applicationFeeCents` for the platform in the same
// transaction. There is no second "collect commission" charge that could fail after the sale succeeded.
//
// All rates are basis points (1 bp = 0.01 %) and all amounts integer minor units. No floats touch money.
export interface FeePolicy {
  /** Commission by seller tier, in basis points. */
  commissionBps: Record<string, number>;
  /** Card processing estimate passed on to the seller. */
  processing: {bps: number; fixedCents: number};
}

// Deliberately odd, fictional numbers: this repository is about mechanics, not pricing.
export const EXAMPLE_FEE_POLICY: FeePolicy = Object.freeze({
  commissionBps: Object.freeze({basic: 1111, plus: 777}),
  processing: Object.freeze({bps: 333, fixedCents: 33}),
}) as FeePolicy;

export interface Split {
  tier: string;
  grossCents: number;
  rateBps: number;
  commissionCents: number;
  processingCents: number;
  /** Sent to the provider as application_fee_amount. */
  applicationFeeCents: number;
  sellerNetCents: number;
}

export function computeSplit(grossCents: number, tier: string, policy: FeePolicy = EXAMPLE_FEE_POLICY): Split {
  if (!Number.isSafeInteger(grossCents) || grossCents <= 0) throw new RangeError('gross must be a positive integer amount');
  const rateBps = policy.commissionBps[tier];
  if (rateBps === undefined || !Number.isSafeInteger(rateBps) || rateBps < 0 || rateBps > 10_000) throw new RangeError('unknown tier: ' + tier);
  const {bps, fixedCents} = policy.processing;
  const commissionCents = Math.min(grossCents, Math.round((grossCents * rateBps) / 10_000));
  // Never take more than what is left after the commission.
  const processingCents = Math.max(0, Math.min(grossCents - commissionCents, Math.round((grossCents * bps) / 10_000) + fixedCents));
  const applicationFeeCents = commissionCents + processingCents;
  return {tier, grossCents, rateBps, commissionCents, processingCents, applicationFeeCents, sellerNetCents: grossCents - applicationFeeCents};
}

/**
 * Cumulative share of the application fee returned after `refundedCents` of `grossCents` were refunded. Computed
 * from the cumulative total (not per refund) so several partial refunds never drift by a cent, and refunding the whole
 * remainder returns the whole fee.
 */
export const feeRefunded = (feeCents: number, grossCents: number, refundedCents: number) =>
  refundedCents >= grossCents ? feeCents : Math.floor((feeCents * refundedCents) / grossCents);
