import type { PricingTokenPayload } from '../types/token';

/**
 * The userId a pricing token was issued for.
 *
 * Reads the `userId` claim. Only tokens without that claim (issued by SPACE versions that predate
 * per-organization userIds, where `sub` is the bare userId) fall back to `sub`. `sub` is never
 * parsed: on newer servers it is an opaque `urn:space:...` subject.
 *
 * This does not verify the token: decode or verify it first.
 *
 * @throws TypeError if the token has a `userId` claim that is not a string.
 */
export function pricingTokenUserId(payload: Pick<PricingTokenPayload, 'sub' | 'userId'>): string {
  const { userId } = payload;
  if (userId === undefined || userId === null) {
    return payload.sub;
  }
  if (typeof userId !== 'string') {
    throw new TypeError('The userId claim of the pricing token is not a string');
  }
  return userId;
}
