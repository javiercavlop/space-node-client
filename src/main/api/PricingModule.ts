import axios from 'axios';
import { SpaceClient } from '../config/SpaceClient';
import { PricingYamlUnavailableError, SpaceFeatureUnsupportedError } from '../errors';
import { GetPricingYamlOptions, PricingYaml } from '../types';

export class PricingModule {
  private spaceClient: SpaceClient;

  /**
   * Creates an instance of the `PricingModule` class.
   *
   * @param spaceClient - An instance of `SpaceClient` used to interact with the Space API.
   */
  constructor(spaceClient: SpaceClient) {
    this.spaceClient = spaceClient;
  }

  /**
   * Retrieves the raw Pricing2Yaml file of a pricing version, byte for byte as SPACE stores it
   * (`GET /services/{serviceName}/pricings/{pricingVersion}?format=yaml`).
   *
   * Pass the `etag` of a copy you already hold to make a conditional request: if the file has not
   * changed, SPACE answers 304 and the result has `notModified: true` and `yaml: null`.
   *
   * @param serviceName - The name of the service.
   * @param pricingVersion - The pricing version (e.g. `2024-06-08`).
   * @param options - Optional `etag` for a conditional request.
   * @returns A promise that resolves with the YAML, its ETag and its syntax version.
   * @throws `PricingYamlUnavailableError` if SPACE cannot provide the original file.
   * @throws `SpaceFeatureUnsupportedError` (capability `pricing-yaml`) if SPACE ignores
   *   `format=yaml` and answers with the JSON pricing (SPACE without S2).
   * @throws The underlying Axios error for any other failure (e.g. 404 unknown version).
   */
  public async getYaml(
    serviceName: string,
    pricingVersion: string,
    options: GetPricingYamlOptions = {}
  ): Promise<PricingYaml> {
    const headers: Record<string, string> = {
      'x-api-key': this.spaceClient.apiKey,
      Accept: 'application/yaml',
    };
    if (options.etag) {
      headers['If-None-Match'] = quoteEtag(options.etag);
    }

    return axios
      .get(
        `${this.spaceClient.httpUrl}/services/${encodeURIComponent(serviceName)}/pricings/${encodeURIComponent(pricingVersion)}`,
        {
          params: { format: 'yaml' },
          headers,
          timeout: this.spaceClient.timeout,
          responseType: 'text',
          // Keep the body as sent: never let axios JSON.parse a YAML file.
          transformResponse: [data => data],
          validateStatus: status => (status >= 200 && status < 300) || status === 304,
        }
      )
      .then(response => {
        const etag = (response.headers['etag'] as string | undefined) ?? null;
        const syntaxVersion =
          (response.headers['x-pricing-syntax-version'] as string | undefined) ?? null;

        if (response.status === 304) {
          return {
            yaml: null,
            etag: etag ?? (options.etag ? quoteEtag(options.etag) : null),
            syntaxVersion,
            notModified: true,
          };
        }

        const contentType = String(response.headers['content-type'] ?? '');
        if (contentType.includes('application/json')) {
          // SPACE versions without S2 ignore `format=yaml` and return the parsed pricing.
          throw new SpaceFeatureUnsupportedError(
            'pricing-yaml',
            `SPACE returned JSON for ${serviceName}@${pricingVersion}: this SPACE version does not support format=yaml`
          );
        }

        return {
          yaml: response.data as string,
          etag,
          syntaxVersion,
          notModified: false,
        };
      })
      .catch(error => {
        if (error instanceof SpaceFeatureUnsupportedError) {
          throw error;
        }
        if (
          error.response?.status === 404 &&
          readErrorCode(error.response.data) === 'PRICING_YAML_UNAVAILABLE'
        ) {
          throw new PricingYamlUnavailableError(serviceName, pricingVersion, error);
        }
        console.error('Error fetching pricing YAML:', error.response?.data ?? error.message);
        throw error;
      });
  }
}

function quoteEtag(etag: string): string {
  return /^(W\/)?".*"$/.test(etag) ? etag : `"${etag}"`;
}

function readErrorCode(data: unknown): string | undefined {
  if (typeof data === 'string') {
    try {
      return JSON.parse(data)?.error;
    } catch {
      return undefined;
    }
  }
  return (data as any)?.error;
}
