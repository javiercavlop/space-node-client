import axios from 'axios';
import { SpaceClient } from '../config/SpaceClient';
import { NewContractsPricing } from '../types';

export class ServiceModule {
  private spaceClient: SpaceClient;

  /**
   * Creates an instance of the `ServiceModule` class.
   *
   * @param spaceClient - An instance of `SpaceClient` used to interact with the Space API.
   */
  constructor(spaceClient: SpaceClient) {
    this.spaceClient = spaceClient;
  }

  /**
   * Retrieves the pricing version SPACE assigns to NEW contracts of a service
   * (`GET /services/{serviceName}/pricings/new-contracts`). Use it to render the pricing page for
   * signed-out visitors.
   *
   * @param serviceName - The name of the service.
   * @returns A promise that resolves with the version, the path of its YAML and how it was chosen.
   * @throws An error if the operation fails.
   */
  public async getNewContractsPricing(serviceName: string): Promise<NewContractsPricing> {
    return axios
      .get(
        `${this.spaceClient.httpUrl}/services/${encodeURIComponent(serviceName)}/pricings/new-contracts`,
        {
          headers: {
            'x-api-key': this.spaceClient.apiKey,
          },
          timeout: this.spaceClient.timeout,
        }
      )
      .then(response => {
        this.spaceClient.observeCapabilities(response.headers);
        return response.data;
      })
      .catch(error => {
        console.error(
          'Error fetching pricing for new contracts:',
          error.response?.data ?? error.message
        );
        throw error;
      });
  }
}
