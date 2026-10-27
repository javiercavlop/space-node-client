import axios from 'axios';
import { io, Socket } from 'socket.io-client';
import { ContractModule } from '../api/ContractModule';
import { FeatureModule } from '../api/FeaturesModule';
import { CacheModule } from '../api/CacheModule';
import { SpaceEvent, SpaceConnectionOptions, CacheOptions } from '../types';

/**
 * The `SpaceClient` class provides an interface to interact with the Space API and WebSocket services.
 * It allows for HTTP requests, WebSocket connections, and event handling for real-time updates.
 */
export class SpaceClient {
  /**
   * The base HTTP URL for the Space API.
   * This URL is derived from the provided `url` in the constructor options and appended with `/api/v1`.
   */
  public httpUrl: string;

  /**
   * The WebSocket client instance used for general communication.
   * This is initialized with the provided `url` in the constructor options.
   */
  private socketClient: Socket;

  /**
   * The WebSocket namespace specifically for pricing-related events.
   */
  private pricingSocketNamespace: Socket; 

  /**
   * The API key used for authenticating requests to the Space API.
   */
  public apiKey: string;

  /**
   * The timeout duration (in milliseconds) for HTTP requests.
   * Defaults to 5000ms if not provided in the constructor options.
   */
  public timeout: number;

  private validEvents: string[] = [
      'synchronized',
      'pricing_created',
      'pricing_archived',
      'pricing_actived',
      'service_disabled',
      'error',
    ];

  /**
   * A record of callback functions registered for specific events.
   * The keys are event names, and the values are the corresponding callback functions.
   */
  private callBackFunctions: Record<string, (data?: any) => void> = {};

  /**
   * An instance of the `ContractModule` class, which provides functionality for managing contracts.
   */
  public contracts: ContractModule;

  /**
   * An instance of the `FeatureModule` class, which provides functionality for evaluating features.
   */
  public features: FeatureModule;

  /**
   * An internal instance of the `CacheModule` class, which provides caching functionality.
   * This module is not exposed publicly and can only be accessed by SpaceClient and its modules.
   */
  private cache: CacheModule;

  /**
   * Constructs a new instance of the `SpaceClient` class.
   * 
   * @param options - Configuration options for the client.
   * @param options.url - The base URL for the Space API.
   * @param options.apiKey - The API key for authenticating requests.
   * @param options.timeout - (Optional) The timeout duration for HTTP requests, in milliseconds.
   * @param options.cache - (Optional) Cache configuration options.
   */
  constructor(options: SpaceConnectionOptions) {
    this.httpUrl = options.url.endsWith('/') ? options.url.slice(0, -1) + '/api/v1' : options.url + '/api/v1';
    this.socketClient = io(options.url.replace(/^http/, 'ws'), {
      path: '/events',
      autoConnect: false,
      transports: ['websocket'],
    });
    this.pricingSocketNamespace = this.socketClient.io.socket('/pricings');
    this.apiKey = options.apiKey;
    this.timeout = options.timeout || 5000; // Default timeout to 5000ms if not provided
    
    // Initialize modules
    this.cache = new CacheModule(this);
    this.contracts = new ContractModule(this);
    this.features = new FeatureModule(this);

    // Initialize cache if configured
    if (options.cache) {
      this.initializeCache(options.cache);
    }

    this.configureSocket();
    this.pricingSocketNamespace.connect();
  }

  /**
   * Checks if the client is connected to the Space API by performing a health check.
   * 
   * @returns A promise that resolves to `true` if the connection is healthy, otherwise `false`.
   */
  public async isConnectedToSpace(): Promise<boolean> {
    const response = await axios.get(`${this.httpUrl}/healthcheck`);

    return response.status === 200 && response.data.message;
  }

  /**
   * Registers a callback function for a specific event.
   * 
   * @param event - The name of the event to listen for. Supported events are:
   *   - `'synchronized'`: Triggered when the WebSocket connection is successfully established.
   *   - `'pricing_change'`: Triggered when there is a change in pricing data.
   *   - `'error'`: Triggered when a connection error occurs.
   * @param callback - The function to execute when the event is triggered.
   */
  public on(event: string, callback: (data?: any) => void): void {
    if (this.validEvents.includes(event.toLowerCase())) {
      this.callBackFunctions[event.toLowerCase()] = callback;
    } else {
      console.warn(`No handler for event: ${event}`);
    }
  }

  public removeListener(event: string): void {
    if (this.validEvents.includes(event.toLowerCase())) {
      delete this.callBackFunctions[event.toLowerCase()];
    } else {
      console.warn(`No handler to remove for event: ${event}`);
    }
  }

  public removeAllListeners(): void {
    for (const event of this.validEvents) {
      delete this.callBackFunctions[event];
    }
  }

  /**
   * Establishes a connection to the pricing WebSocket namespace.
   * If already connected, this method does nothing.
   */
  public connect(): void {
    if (!this.pricingSocketNamespace.connected) {
      this.pricingSocketNamespace.connect();
    }
  }

  /**
   * Disconnects from the pricing WebSocket namespace.
   * The listeners registered with `on()` are kept, so `connect()` resumes delivering events to them.
   * If already disconnected, this method does nothing.
   */
  public disconnect(): void {
    if (this.pricingSocketNamespace.connected) {
      this.pricingSocketNamespace.disconnect();
    }
  }

  /**
   * Close all connections and cleanup resources
   * This includes WebSocket connections and cache providers
   */
  public async close(): Promise<void> {
    this.disconnect();
    // The client is not reused after close(): drop the socket handlers.
    this.pricingSocketNamespace.removeAllListeners();
    
    if (this.cache) {
      await this.cache.close();
    }
  }

  /**
   * Get the internal cache module
   * This method is internal and should only be used by SpaceClient modules
   * @internal
   */
  getCache(): CacheModule {
    return this.cache;
  }

  /**
   * Initialize the cache with the provided options
   * @private
   */
  private async initializeCache(cacheOptions: CacheOptions): Promise<void> {
    try {
      await this.cache.initialize(cacheOptions);
    } catch (error) {
      console.warn('[SpaceClient] Cache initialization failed, continuing without cache:', error);
    }
  }

  /**
   * Configures the WebSocket namespace for handling events.
   * This method sets up listeners for the following events:
   *   - `'connect'`: Logs a message and triggers the `'synchronized'` callback if registered.
   *   - `'message'`: Handles incoming messages and triggers the appropriate callback based on the message code.
   *   - `'connect_error'`: Triggers the `'error'` callback if registered.
   * 
   * @private
   */
  private configureSocket() {
    this.pricingSocketNamespace.on('connect', () => {
      console.log('Connected to Space WebSocket');
      if (this.callBackFunctions['synchronized']) {
        this.callBackFunctions['synchronized']();
      }
    });

    this.pricingSocketNamespace.on('message', data => {
      const event = (data.code as SpaceEvent).toLowerCase();
      const callback = this.callBackFunctions[event];

      if (callback) {
        callback(data.details);
      }
    });

    this.pricingSocketNamespace.on('connect_error', error => {
      if (this.callBackFunctions['error']) {
        this.callBackFunctions['error'](error);
      }
    });
  }
}
