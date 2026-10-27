import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  SignJWT,
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type JWK,
  type JWTPayload,
} from 'jose';
import {
  PricingTokenAudienceError,
  PricingTokenExpiredError,
  PricingTokenIssuerError,
  PricingTokenSignatureError,
  PricingTokenUnknownKeyError,
  PricingTokenVerificationError,
  PricingTokenVerifier,
  SpaceClient,
  SpaceFeatureUnsupportedError,
  pricingTokenUserId,
} from '../../main/index';
import { MockSpace } from './mockSpace';

const ORG = '6630a1b2c3d4e5f6a7b8c9d0';
const OTHER_ORG = '6630a1b2c3d4e5f6a7b8c9ff';
const JWKS_PATH = '/.well-known/jwks.json';
const CAPABILITIES = ['contract-userid-per-org', 'pricing-token-jwks'];

interface TestKey {
  privateKey: CryptoKey;
  publicJwk: JWK;
  kid: string;
}

async function newKey(): Promise<TestKey> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(jwk);
  return { privateKey, kid, publicJwk: { ...jwk, kid, alg: 'ES256', use: 'sig' } };
}

/** Signs a token like SPACE with per-organization userIds and ES256 (space#80 + space#87). */
async function sign(
  key: TestKey,
  options: {
    userId?: string;
    organizationId?: string;
    audience?: string;
    issuer?: string;
    expiresAt?: number;
    header?: Record<string, unknown>;
    omitExp?: boolean;
  } = {}
): Promise<string> {
  const userId = options.userId ?? 'user-1';
  const organizationId = options.organizationId ?? ORG;
  const jwt = new SignJWT({ userId, organizationId, features: {}, subscriptionContext: {} })
    .setProtectedHeader({ alg: 'ES256', kid: key.kid, ...(options.header ?? {}) })
    .setIssuedAt()
    .setSubject(`urn:space:${organizationId}:${encodeURIComponent(userId)}`)
    .setIssuer(options.issuer ?? 'space')
    .setAudience(options.audience ?? organizationId);
  if (!options.omitExp) {
    jwt.setExpirationTime(options.expiresAt ?? '1h');
  }
  return jwt.sign(key.privateKey);
}

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function claims(token: string): JWTPayload {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the verification to fail');
}

describe('Pricing token verification against the JWKS of a mocked SPACE (space#87)', () => {
  const space = new MockSpace();
  let key: TestKey;
  let published: JWK[];
  let cacheControl: string | undefined;

  const jwksRequests = () => space.requests.filter(r => r.path === JWKS_PATH).length;

  function serveJwks(): void {
    space.capabilities = CAPABILITIES;
    space.route('GET', JWKS_PATH, () => ({
      status: 200,
      body: { keys: published },
      headers: {
        'content-type': 'application/jwk-set+json',
        ...(cacheControl !== undefined ? { 'cache-control': cacheControl } : {}),
      },
    }));
  }

  function verifier(options: Partial<ConstructorParameters<typeof PricingTokenVerifier>[0]> = {}) {
    return new PricingTokenVerifier({ url: space.url, organizationId: ORG, ...options });
  }

  beforeAll(async () => {
    await space.start();
    key = await newKey();
  });

  afterEach(() => {
    space.reset();
  });

  afterAll(async () => {
    await space.stop();
  });

  function setUp(): void {
    published = [key.publicJwk];
    cacheControl = 'public, max-age=300';
    serveJwks();
  }

  it('Should accept a valid token and return its typed payload', async () => {
    setUp();
    const token = await sign(key, { userId: 'a:b/ñ' });

    const payload = await verifier().verify(token);

    expect(payload.userId).toBe('a:b/ñ');
    expect(payload.organizationId).toBe(ORG);
    expect(payload.aud).toBe(ORG);
    expect(payload.iss).toBe('space');
    expect(payload.sub).toBe(`urn:space:${ORG}:${encodeURIComponent('a:b/ñ')}`);
    expect(pricingTokenUserId(payload)).toBe('a:b/ñ');
    expect(space.requests.map(r => `${r.method} ${r.path}`)).toEqual([`GET ${JWKS_PATH}`]);
    expect(space.lastRequest().headers['x-api-key']).toBeUndefined();
  });

  it('Should verify through SpaceClient with the organizationId of the client or of the call', async () => {
    setUp();
    const token = await sign(key);
    const client = new SpaceClient({ url: space.url, apiKey: 'usr_key', organizationId: ORG });
    const orgKeyClient = new SpaceClient({ url: space.url, apiKey: 'org-key' });
    try {
      expect((await client.features.verifyPricingToken(token)).userId).toBe('user-1');
      expect(
        (await orgKeyClient.features.verifyPricingToken(token, { organizationId: ORG })).userId
      ).toBe('user-1');
      await expect(orgKeyClient.features.verifyPricingToken(token)).rejects.toThrow(TypeError);
      await expect(
        client.features.verifyPricingToken(token, { organizationId: OTHER_ORG })
      ).rejects.toBeInstanceOf(PricingTokenAudienceError);
    } finally {
      await client.close();
      await orgKeyClient.close();
    }
  });

  it('Should require an organizationId', async () => {
    setUp();
    const noOrg = new PricingTokenVerifier({ url: space.url });
    await expect(noOrg.verify(await sign(key))).rejects.toThrow(/organizationId/);
    expect((await noOrg.verify(await sign(key), { organizationId: ORG })).organizationId).toBe(ORG);
  });

  it('Should reject a token signed by another key under a published kid', async () => {
    setUp();
    const attacker = await newKey();
    const token = await sign({ ...attacker, kid: key.kid });

    const error = await rejection(verifier().verify(token));
    expect(error).toBeInstanceOf(PricingTokenSignatureError);
    expect(error).toMatchObject({ code: 'PRICING_TOKEN_SIGNATURE_INVALID' });
  });

  it('Should reject a token whose kid is not published', async () => {
    setUp();
    const other = await newKey();
    const token = await sign(other);

    // A JWKS fetched just now is not fetched again for an unknown kid.
    const error = await rejection(verifier().verify(token));
    expect(error).toBeInstanceOf(PricingTokenUnknownKeyError);
    expect(error).toMatchObject({ code: 'PRICING_TOKEN_UNKNOWN_KID', kid: other.kid });
    expect(jwksRequests()).toBe(1);

    // A cached JWKS older than the cooldown is fetched once more before giving up.
    let now = 1_000_000;
    const v = verifier({ now: () => now });
    await v.verify(await sign(key));
    now += 60_000;
    await expect(v.verify(token)).rejects.toBeInstanceOf(PricingTokenUnknownKeyError);
    expect(jwksRequests()).toBe(3);
  });

  it('Should reject a tampered payload', async () => {
    setUp();
    const token = await sign(key, { userId: 'user-1' });
    const [header, , signature] = token.split('.');
    const forged = `${header}.${b64url({ ...claims(token), userId: 'admin' })}.${signature}`;

    await expect(verifier().verify(forged)).rejects.toBeInstanceOf(PricingTokenSignatureError);
  });

  it('Should reject an expired token, with an optional leeway', async () => {
    setUp();
    const now = Math.floor(Date.now() / 1000);
    const token = await sign(key, { expiresAt: now - 10 });

    const error = await rejection(verifier().verify(token));
    expect(error).toBeInstanceOf(PricingTokenExpiredError);
    expect(error).toMatchObject({ code: 'PRICING_TOKEN_EXPIRED' });
    expect((error as PricingTokenExpiredError).expiredAt?.getTime()).toBe((now - 10) * 1000);

    expect((await verifier({ clockToleranceSeconds: 60 }).verify(token)).userId).toBe('user-1');
    await expect(
      verifier({ clockToleranceSeconds: 60 }).verify(await sign(key, { expiresAt: now - 120 }))
    ).rejects.toBeInstanceOf(PricingTokenExpiredError);
  });

  it('Should reject a token without exp', async () => {
    setUp();
    const error = await rejection(verifier().verify(await sign(key, { omitExp: true })));
    expect(error).toBeInstanceOf(PricingTokenVerificationError);
    expect(error).toMatchObject({ code: 'PRICING_TOKEN_INVALID' });
  });

  it('Should reject a token of another organization (aud and organizationId)', async () => {
    setUp();
    const otherOrgToken = await sign(key, { organizationId: OTHER_ORG });
    const error = await rejection(verifier().verify(otherOrgToken));
    expect(error).toBeInstanceOf(PricingTokenAudienceError);
    expect(error).toMatchObject({ code: 'PRICING_TOKEN_WRONG_AUDIENCE', expected: ORG });

    // aud of this organization but organizationId of another one.
    const mixed = await sign(key, { organizationId: OTHER_ORG, audience: ORG });
    await expect(verifier().verify(mixed)).rejects.toBeInstanceOf(PricingTokenAudienceError);
  });

  it('Should check iss, `space` by default or the configured issuer', async () => {
    setUp();
    const token = await sign(key, { issuer: 'https://space.example.com' });

    const error = await rejection(verifier().verify(token));
    expect(error).toBeInstanceOf(PricingTokenIssuerError);
    expect(error).toMatchObject({ code: 'PRICING_TOKEN_WRONG_ISSUER', expected: 'space' });
    const custom = verifier({ issuer: 'https://space.example.com' });
    expect((await custom.verify(token)).iss).toBe('https://space.example.com');
    await expect(custom.verify(await sign(key))).rejects.toBeInstanceOf(PricingTokenIssuerError);
  });

  it('Should reject an HS256 token, even one naming a published kid', async () => {
    setUp();
    const secret = new TextEncoder().encode('a-shared-secret-of-thirty-two-bytes!');
    const token = await new SignJWT({ userId: 'user-1', organizationId: ORG, features: {} })
      .setProtectedHeader({ alg: 'HS256', kid: key.kid })
      .setIssuedAt()
      .setExpirationTime('1h')
      .setSubject('user-1')
      .setIssuer('space')
      .setAudience(ORG)
      .sign(secret);

    const error = await rejection(verifier().verify(token));
    expect(error).toBeInstanceOf(PricingTokenVerificationError);
    expect(error).toMatchObject({ code: 'PRICING_TOKEN_INVALID' });
    expect(String((error as Error).message)).toMatch(/HS256/);
  });

  it('Should reject an unsecured token (alg: none)', async () => {
    setUp();
    const now = Math.floor(Date.now() / 1000);
    const body = { sub: 'x', userId: 'user-1', organizationId: ORG, aud: ORG, iss: 'space', iat: now, exp: now + 3600, features: {} };
    for (const header of [{ alg: 'none' }, { alg: 'none', kid: key.kid }, { alg: 'NONE', kid: key.kid }]) {
      const token = `${b64url(header)}.${b64url(body)}.`;
      const error = await rejection(verifier().verify(token));
      expect(error).toBeInstanceOf(PricingTokenVerificationError);
      expect(error).toMatchObject({ code: 'PRICING_TOKEN_INVALID' });
    }
  });

  it('Should never follow a jku, x5u or embedded jwk header', async () => {
    setUp();
    const attacker = await newKey();
    space.route('GET', '/attacker/jwks.json', { status: 200, body: { keys: [attacker.publicJwk] } });
    const attackerJwks = `${space.url}/api/v1/attacker/jwks.json`;

    const tokens = [
      await sign(attacker, { header: { jku: attackerJwks } }),
      await sign(attacker, { header: { x5u: attackerJwks } }),
      await sign(attacker, { header: { jwk: { ...attacker.publicJwk, alg: undefined, use: undefined } } }),
      // Even with the published kid and the right key, SPACE never sends these headers.
      await sign(key, { header: { jku: attackerJwks } }),
    ];
    for (const token of tokens) {
      const error = await rejection(verifier().verify(token));
      expect(error).toBeInstanceOf(PricingTokenVerificationError);
      expect(error).not.toBeInstanceOf(SpaceFeatureUnsupportedError);
    }
    expect(space.requests.some(r => r.path.startsWith('/attacker'))).toBe(false);
  });

  it('Should reject malformed tokens', async () => {
    setUp();
    for (const token of ['', 'abc', 'a.b.c', `${b64url({ alg: 'ES256' })}.${b64url({})}.`]) {
      const error = await rejection(verifier().verify(token));
      expect(error).toBeInstanceOf(PricingTokenVerificationError);
    }
  });

  it('Should report a SPACE without pricing-token-jwks', async () => {
    const token = await sign(key);

    // SPACE before space#87: no JWKS route.
    space.capabilities = ['contract-userid-per-org'];
    const old = await rejection(verifier().verify(token));
    expect(old).toBeInstanceOf(SpaceFeatureUnsupportedError);
    expect(old).toMatchObject({ capability: 'pricing-token-jwks', written: false });

    // A SPACE in legacy HS256 mode serves the route but does not advertise the capability.
    space.route('GET', JWKS_PATH, { status: 200, body: { keys: [key.publicJwk] } });
    await expect(verifier().verify(token)).rejects.toBeInstanceOf(SpaceFeatureUnsupportedError);

    // A SPACE that predates X-Space-Capabilities.
    space.capabilities = null;
    await expect(verifier().verify(token)).rejects.toBeInstanceOf(SpaceFeatureUnsupportedError);
  });

  it('Should report an unavailable JWKS as a verification error', async () => {
    space.capabilities = CAPABILITIES;
    space.route('GET', JWKS_PATH, { status: 503, body: { error: 'Pricing token keys are not available.' } });
    const error = await rejection(verifier().verify(await sign(key)));
    expect(error).toBeInstanceOf(PricingTokenVerificationError);
    expect(error).toMatchObject({ code: 'PRICING_TOKEN_JWKS_UNAVAILABLE' });
  });

  it('Should cache the JWKS for the max-age of the response', async () => {
    setUp();
    cacheControl = 'public, max-age=10';
    let now = 1_000_000;
    const v = verifier({ now: () => now });
    const token = await sign(key);

    await v.verify(token);
    await v.verify(token);
    now += 9_000;
    await v.verify(token);
    expect(jwksRequests()).toBe(1);

    now += 2_000;
    await v.verify(token);
    expect(jwksRequests()).toBe(2);
  });

  it('Should use a 5 minute default without Cache-Control, and not cache with no-store', async () => {
    setUp();
    cacheControl = undefined;
    let now = 1_000_000;
    const v = verifier({ now: () => now });
    const token = await sign(key);
    await v.verify(token);
    now += 299_000;
    await v.verify(token);
    expect(jwksRequests()).toBe(1);
    now += 2_000;
    await v.verify(token);
    expect(jwksRequests()).toBe(2);

    space.requests.length = 0;
    cacheControl = 'no-store';
    const noStore = verifier({ now: () => now });
    await noStore.verify(token);
    await noStore.verify(token);
    expect(jwksRequests()).toBe(2);
  });

  it('Should fetch the JWKS once for concurrent verifications', async () => {
    setUp();
    const v = verifier();
    const token = await sign(key);
    await Promise.all([v.verify(token), v.verify(token), v.verify(token)]);
    expect(jwksRequests()).toBe(1);
  });

  it('Should refetch the JWKS on an unknown kid (rotation), with a cooldown', async () => {
    setUp();
    let now = 1_000_000;
    const v = verifier({ now: () => now, refetchCooldownMs: 30_000 });
    await v.verify(await sign(key));
    expect(jwksRequests()).toBe(1);

    // SPACE rotates: the new key signs, the old one stays published as a previous key.
    const next = await newKey();
    published = [next.publicJwk, key.publicJwk];
    now += 31_000;
    expect((await v.verify(await sign(next))).userId).toBe('user-1');
    expect(jwksRequests()).toBe(2);
    // Old tokens still verify, from the cache.
    await v.verify(await sign(key));
    expect(jwksRequests()).toBe(2);

    // Unknown kids within the cooldown do not hit SPACE again.
    const unknown = await newKey();
    now += 1_000;
    await expect(v.verify(await sign(unknown))).rejects.toBeInstanceOf(PricingTokenUnknownKeyError);
    await expect(v.verify(await sign(unknown))).rejects.toBeInstanceOf(PricingTokenUnknownKeyError);
    expect(jwksRequests()).toBe(2);

    // After the cooldown it refetches once more.
    now += 30_000;
    await expect(v.verify(await sign(unknown))).rejects.toBeInstanceOf(PricingTokenUnknownKeyError);
    expect(jwksRequests()).toBe(3);
  });

  it('Should stop trusting a key removed from the JWKS once the cache expires', async () => {
    setUp();
    cacheControl = 'max-age=300';
    let now = 1_000_000;
    const v = verifier({ now: () => now });
    const token = await sign(key);
    await v.verify(token);

    const next = await newKey();
    published = [next.publicJwk];
    now += 301_000;
    await expect(v.verify(token)).rejects.toBeInstanceOf(PricingTokenUnknownKeyError);
  });

  it('Should ignore published keys that are not ES256 signing keys', async () => {
    setUp();
    published = [{ ...key.publicJwk, use: 'enc' }];
    await expect(verifier().verify(await sign(key))).rejects.toBeInstanceOf(
      PricingTokenUnknownKeyError
    );
  });
});
