/**
 * Thrown by `pricings.getYaml` when SPACE knows the pricing version but cannot provide its original
 * Pricing2Yaml file (`404 {error: "PRICING_YAML_UNAVAILABLE"}`), e.g. a historical SPHERE-linked
 * version that SPACE only keeps as parsed JSON.
 */
export class PricingYamlUnavailableError extends Error {
  public readonly code = 'PRICING_YAML_UNAVAILABLE';

  constructor(
    public readonly serviceName: string,
    public readonly pricingVersion: string,
    public readonly cause?: unknown
  ) {
    super(`The Pricing2Yaml of ${serviceName}@${pricingVersion} is not available in SPACE`);
    this.name = 'PricingYamlUnavailableError';
  }
}
