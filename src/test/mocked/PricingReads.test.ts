import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { connect, SpaceClient, PricingYamlUnavailableError } from '../../main/index';
import { MockSpace } from './mockSpace';

const API_KEY = 'test-org-key';

const YAML = `syntaxVersion: "3.0"
saasName: Acme
version: "2024-06-08"
# comments and key order must survive byte for byte
plans:
  growth:
    price: 10
`;

describe('Pricing reads against a mocked SPACE (S2, S3, S13)', () => {
  const space = new MockSpace();
  let client: SpaceClient;

  beforeAll(async () => {
    await space.start();
    client = connect({ url: space.url, apiKey: API_KEY });
  });

  afterEach(() => {
    space.reset();
  });

  afterAll(async () => {
    await client.close();
    await space.stop();
  });

  describe('pricings.getYaml (S2)', () => {
    it('Should return the raw Pricing2Yaml, the ETag and the syntax version', async () => {
      space.route('GET', '/services/acme/pricings/2024-06-08', req => {
        expect(req.query.get('format')).toBe('yaml');
        return {
          status: 200,
          body: YAML,
          headers: {
            'content-type': 'application/yaml; charset=utf-8',
            etag: '"abc123"',
            'x-pricing-syntax-version': '3.0',
          },
        };
      });

      const result = await client.pricings.getYaml('acme', '2024-06-08');

      expect(result.notModified).toBe(false);
      expect(result.yaml).toBe(YAML);
      expect(result.etag).toBe('"abc123"');
      expect(result.syntaxVersion).toBe('3.0');
      expect(space.lastRequest().headers['x-api-key']).toBe(API_KEY);
      expect(space.lastRequest().headers['if-none-match']).toBeUndefined();
    });

    it('Should not parse YAML bodies that happen to be valid JSON', async () => {
      space.route('GET', '/services/acme/pricings/1.0.0', {
        status: 200,
        body: '{"saasName": "Acme"}',
        headers: { 'content-type': 'application/yaml; charset=utf-8' },
      });

      const result = await client.pricings.getYaml('acme', '1.0.0');

      expect(result.yaml).toBe('{"saasName": "Acme"}');
      expect(result.etag).toBeNull();
      expect(result.syntaxVersion).toBeNull();
    });

    it('Should send If-None-Match and report notModified on 304', async () => {
      space.route('GET', '/services/acme/pricings/2024-06-08', req => {
        expect(req.headers['if-none-match']).toBe('"abc123"');
        return { status: 304, headers: { etag: '"abc123"' } };
      });

      const result = await client.pricings.getYaml('acme', '2024-06-08', { etag: '"abc123"' });

      expect(result.notModified).toBe(true);
      expect(result.yaml).toBeNull();
      expect(result.etag).toBe('"abc123"');
    });

    it('Should quote a bare etag before sending it', async () => {
      space.route('GET', '/services/acme/pricings/2024-06-08', { status: 304 });

      const result = await client.pricings.getYaml('acme', '2024-06-08', { etag: 'abc123' });

      expect(space.lastRequest().headers['if-none-match']).toBe('"abc123"');
      expect(result.etag).toBe('"abc123"');
    });

    it('Should URL-encode service names and versions', async () => {
      space.route('GET', '/services/my%20svc/pricings/v1%2Fbeta', {
        status: 200,
        body: YAML,
      });

      const result = await client.pricings.getYaml('my svc', 'v1/beta');

      expect(result.yaml).toBe(YAML);
    });

    it('Should reject a JSON pricing (SPACE without format=yaml support)', async () => {
      space.route('GET', '/services/acme/pricings/1.0.0', {
        status: 200,
        body: { saasName: 'Acme', version: '1.0.0' },
      });

      const error = await client.pricings.getYaml('acme', '1.0.0').catch(e => e);

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toMatch(/format=yaml/);
    });

    it('Should throw PricingYamlUnavailableError on 404 PRICING_YAML_UNAVAILABLE', async () => {
      space.route('GET', '/services/acme/pricings/2020-01-01', {
        status: 404,
        body: { error: 'PRICING_YAML_UNAVAILABLE' },
      });

      const error = await client.pricings.getYaml('acme', '2020-01-01').catch(e => e);

      expect(error).toBeInstanceOf(PricingYamlUnavailableError);
      expect(error.serviceName).toBe('acme');
      expect(error.pricingVersion).toBe('2020-01-01');
    });

    it('Should rethrow other HTTP errors unchanged', async () => {
      space.route('GET', '/services/acme/pricings/9.9.9', {
        status: 404,
        body: { error: 'Pricing not found' },
      });

      const error = await client.pricings.getYaml('acme', '9.9.9').catch(e => e);

      expect(error).not.toBeInstanceOf(PricingYamlUnavailableError);
      expect(error.response.status).toBe(404);
    });
  });

  describe('contracts.getPricings (S3)', () => {
    it('Should return the pricing version of every contracted service', async () => {
      const body = {
        services: {
          acme: {
            version: '2024-06-08',
            status: 'archived',
            yamlUrl: '/api/v1/services/acme/pricings/2024-06-08?format=yaml',
            newContractsVersion: '2025-01-10',
            plan: 'growth',
            addOns: { extraStorage: 2 },
          },
        },
        contractVersion: '3:2026-10-27T10:00:00.000Z',
      };
      space.route('GET', '/contracts/user-1/pricings', { status: 200, body });

      const result = await client.contracts.getPricings('user-1');

      expect(result).toEqual(body);
      expect(result.services.acme.status).toBe('archived');
      expect(space.lastRequest().headers['x-api-key']).toBe(API_KEY);
    });

    it('Should propagate 404 when the contract is not in the caller organisation', async () => {
      space.route('GET', '/contracts/other-org-user/pricings', {
        status: 404,
        body: { error: 'Contract not found' },
      });

      const error = await client.contracts.getPricings('other-org-user').catch(e => e);

      expect(error.response.status).toBe(404);
    });
  });

  describe('services.getNewContractsPricing (S13)', () => {
    it('Should return the version SPACE assigns to new contracts', async () => {
      const body = {
        version: '2025-01-10',
        yamlUrl: '/api/v1/services/acme/pricings/2025-01-10?format=yaml',
        source: 'sphere-policy',
      };
      space.route('GET', '/services/acme/pricings/new-contracts', { status: 200, body });

      const result = await client.services.getNewContractsPricing('acme');

      expect(result).toEqual(body);
      expect(space.lastRequest().headers['x-api-key']).toBe(API_KEY);
    });
  });
});
