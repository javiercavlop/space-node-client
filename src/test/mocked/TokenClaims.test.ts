import { describe, it, expect, expectTypeOf } from 'vitest';
import { pricingTokenUserId, type PricingTokenPayload } from '../../main/index';

const ORG = '6630a1b2c3d4e5f6a7b8c9d0';

/** A token payload as issued by SPACE with per-organization userIds (space#80). */
function newServerPayload(userId: string): PricingTokenPayload {
  return {
    sub: `urn:space:${ORG}:${encodeURIComponent(userId)}`,
    userId,
    organizationId: ORG,
    aud: ORG,
    iss: 'space',
    iat: 1_700_000_000,
    exp: 1_700_003_600,
    features: {},
  };
}

/** A token payload as issued by older SPACE versions: the userId in `sub`, no other claims. */
function oldServerPayload(userId: string): PricingTokenPayload {
  return { sub: userId, iat: 1_700_000_000, exp: 1_700_003_600, features: {} };
}

describe('Pricing token claims (space#80)', () => {
  it('Should read the userId claim of tokens from new servers', () => {
    expect(pricingTokenUserId(newServerPayload('user-1'))).toBe('user-1');
  });

  it('Should return the raw userId, not the percent-encoded part of the URN', () => {
    for (const userId of ['a:b', 'a%3Ab', 'with space', 'mail@example.com', 'a/b', 'ñandú']) {
      const payload = newServerPayload(userId);
      expect(payload.sub).not.toBe(userId);
      expect(pricingTokenUserId(payload)).toBe(userId);
    }
  });

  it('Should never parse sub when the token has a userId claim', () => {
    const payload = { ...newServerPayload('user-1'), sub: 'urn:space:other-org:someone-else' };
    expect(pricingTokenUserId(payload)).toBe('user-1');
  });

  it('Should fall back to sub for tokens from servers without the userId claim', () => {
    expect(pricingTokenUserId(oldServerPayload('user-1'))).toBe('user-1');
    // An old token whose userId happens to look like a URN is returned as it is.
    expect(pricingTokenUserId(oldServerPayload('urn:space:x:y'))).toBe('urn:space:x:y');
  });

  it('Should reject a userId claim that is not a string instead of falling back to sub', () => {
    const payload = { ...newServerPayload('user-1'), userId: 42 } as unknown as PricingTokenPayload;
    expect(() => pricingTokenUserId(payload)).toThrow(TypeError);
    expect(() => pricingTokenUserId(payload)).toThrow(/userId claim/);
  });

  it('Should type the new claims as optional', () => {
    expectTypeOf<PricingTokenPayload['userId']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<PricingTokenPayload['organizationId']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<PricingTokenPayload['aud']>().toEqualTypeOf<string | string[] | undefined>();
    expectTypeOf<PricingTokenPayload['iss']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<PricingTokenPayload['sub']>().toEqualTypeOf<string>();
    expectTypeOf(pricingTokenUserId).returns.toEqualTypeOf<string>();
  });
});
