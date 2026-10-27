import axios from 'axios';
import { io, Socket } from 'socket.io-client';
import { ContractModule } from '../api/ContractModule';
import { FeatureModule } from '../api/FeaturesModule';
import { CacheModule } from '../api/CacheModule';
import { PricingModule } from '../api/PricingModule';
import { ServiceModule } from '../api/ServiceModule';
import {
  SpaceEvent,
  SpaceConnectionOptions,
  CacheOptions,
  ContractEventDetails,
  ContractEventName,
  PricingEventDetails,
  PricingEventName,
} from '../types';

const CONTRACT_EVENTS: ContractEventName[] = [
  'contract_created',
  'contract_novated',
  'contract_deleted',
  'contract_renewed',
];

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
   * The authenticated WebSocket namespace for contract events of the caller's organisation.
   * It is only opened once a listener for a contract event is registered.
   */
  private contractSocketNamespace: Socket | null = null;

  /**
   * The API key used for authenticating requests to the Space API.
   */
  public apiKey: string;

  /**
   * The organisation sent with the `/contracts` handshake (needed for member user keys).
   */
  public organizationId?: string;

  /**
   * The timeout duration (in milliseconds) for HTTP requests.
   * Defaults to 5000ms if not provided in the constructor options.
   */
  public timeout: number;

  /**
   * How long the capabilities advertised by SPACE (`X-Space-Capabilities`) are trusted before the
   * client checks them again.
   */
  public static readonly CAPABILITIES_TTL_MS = 60_000;

  /**
   * The capabilities last seen on a SPACE response and when they were seen; `null` if unknown.
   */
  private capabilities: { tokens: Set<string>; seenAt: number } | null = null;

  private validEvents: string[] = [
      'synchronized',
      'pricing_created',
      'pricing_archived',
      'pricing_actived',
      'service_disabled',
      ...CONTRACT_EVENTS,
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
   * An instance of the `PricingModule` class, which provides access to pricing files.
   */
  public pricings: PricingModule;

  /**
   * An instance of the `ServiceModule` class, which provides access to service-level information.
   */
  public services: ServiceModule;

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
   * @param options.organizationId - (Optional) The organisation of a member user key (`usr_...`),
   *   sent with the `/contracts` events handshake.
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
    this.organizationId = options.organizationId;
    this.timeout = options.timeout || 5000; // Default timeout to 5000ms if not provided
    
    // Initialize modules
    this.cache = new CacheModule(this);
    this.contracts = new ContractModule(this);
    this.features = new FeatureModule(this);
    this.pricings = new PricingModule(this);
    this.services = new ServiceModule(this);

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
   *   - `'pricing_created'`, `'pricing_archived'`, `'pricing_actived'`, `'service_disabled'`:
   *     Triggered when there is a change in pricing data.
   *   - `'contract_created'`, `'contract_novated'`, `'contract_deleted'`, `'contract_renewed'`:
   *     Triggered when a contract of the API key's organisation changes. Registering the first of
   *     these listeners opens the authenticated `/contracts` namespace. Cached data of the affected
   *     user is invalidated before the callback runs.
   *   - `'error'`: Triggered when a connection error occurs (including a rejected API key on the
   *     `/contracts` namespace).
   * @param callback - The function to execute when the event is triggered.
   */
  public on(event: ContractEventName, callback: (data: ContractEventDetails) => void): void;
  public on(event: PricingEventName, callback: (data: PricingEventDetails) => void): void;
  public on(event: string, callback: (data?: any) => void): void;
  public on(event: string, callback: (data?: any) => void): void {
    const name = event.toLowerCase();
    if (this.validEvents.includes(name)) {
      this.callBackFunctions[name] = callback;
      if (isContractEvent(name)) {
        this.connectContractSocket();
      }
    } else {
      console.warn(`No handler for event: ${event}`);
    }
  }

  public removeListener(event: string): void {
    if (this.validEvents.includes(event.toLowerCase())) {
      delete this.callBackFunctions[event.toLowerCase()];
      if (!this.hasContractListeners()) {
        this.disconnectContractSocket();
      }
    } else {
      console.warn(`No handler to remove for event: ${event}`);
    }
  }

  public removeAllListeners(): void {
    for (const event of this.validEvents) {
      delete this.callBackFunctions[event];
    }
    this.disconnectContractSocket();
  }

  /**
   * Establishes a connection to the pricing WebSocket namespace.
   * If already connected, this method does nothing.
   */
  public connect(): void {
    if (!this.pricingSocketNamespace.connected) {
      this.pricingSocketNamespace.connect();
    }
    if (this.hasContractListeners()) {
      this.connectContractSocket();
    }
  }

  /**
   * Disconnects from the pricing (and, if open, contracts) WebSocket namespaces and removes all
   * event listeners. If already disconnected, this method does nothing.
   */
  public disconnect(): void {
    this.disconnectContractSocket();
    if (this.pricingSocketNamespace.connected) {
      this.pricingSocketNamespace.disconnect();
      this.pricingSocketNamespace.removeAllListeners();
    }
  }

  /**
   * Close all connections and cleanup resources
   * This includes WebSocket connections and cache providers
   */
  public async close(): Promise<void> {
    this.disconnect();
    
    if (this.cache) {
      await this.cache.close();
    }
  }

  /**
   * Records the capabilities advertised by a SPACE response (`X-Space-Capabilities`, see S0).
   * A successful response without the header comes from a SPACE that predates it, i.e. one that
   * implements none of the advertised features; an error response without it is ignored (it may
   * come from a proxy).
   * @internal
   */
  observeCapabilities(headers: unknown, successful = true): void {
    const raw = readHeader(headers, 'x-space-capabilities');
    if (raw === undefined && !successful) {
      return;
    }
    const tokens = new Set(
      (raw ?? '')
        .split(',')
        .map(token => token.trim().toLowerCase())
        .filter(Boolean)
    );
    this.capabilities = { tokens, seenAt: Date.now() };
  }

  /**
   * The capabilities seen on a SPACE response less than `CAPABILITIES_TTL_MS` ago, or `null` if
   * they have to be checked again.
   * @internal
   */
  getCachedCapabilities(): ReadonlySet<string> | null {
    if (!this.capabilities) {
      return null;
    }
    if (Date.now() - this.capabilities.seenAt > SpaceClient.CAPABILITIES_TTL_MS) {
      return null;
    }
    return this.capabilities.tokens;
  }

  /**
   * Forgets the cached SPACE capabilities, so that the next call that depends on one checks it
   * again (e.g. right after upgrading SPACE).
   */
  public clearCapabilities(): void {
    this.capabilities = null;
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

  /**
   * Opens the authenticated `/contracts` namespace (creating and wiring it on first use).
   * @private
   */
  private connectContractSocket(): void {
    if (!this.contractSocketNamespace) {
      this.contractSocketNamespace = this.socketClient.io.socket('/contracts', {
        auth:
          this.organizationId !== undefined
            ? { apiKey: this.apiKey, organizationId: this.organizationId }
            : { apiKey: this.apiKey },
      });
      this.configureContractSocket(this.contractSocketNamespace);
    }
    if (!this.contractSocketNamespace.connected && !this.contractSocketNamespace.active) {
      this.contractSocketNamespace.connect();
    }
  }

  /**
   * Closes the `/contracts` namespace, keeping its handlers so that it can be reopened.
   * @private
   */
  private disconnectContractSocket(): void {
    if (this.contractSocketNamespace) {
      this.contractSocketNamespace.disconnect();
    }
  }

  private hasContractListeners(): boolean {
    return CONTRACT_EVENTS.some(event => this.callBackFunctions[event] !== undefined);
  }

  /**
   * Dispatches contract events to their callbacks, invalidating the cached data of the affected
   * user first so that callbacks reading the contract or a pricing token get fresh data.
   * @private
   */
  private configureContractSocket(socket: Socket) {
    socket.on('message', async data => {
      const event = String(data?.code ?? '').toLowerCase();
      const details: ContractEventDetails | undefined = data?.details;

      if (details?.userId) {
        await this.cache.invalidateUser(details.userId);
      }

      const callback = this.callBackFunctions[event];
      if (callback && isContractEvent(event)) {
        callback(details);
      }
    });

    socket.on('connect_error', error => {
      if (this.callBackFunctions['error']) {
        this.callBackFunctions['error'](error);
      }
    });
  }
}

function isContractEvent(event: string): event is ContractEventName {
  return (CONTRACT_EVENTS as string[]).includes(event);
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') {
    return undefined;
  }
  const getter = (headers as { get?: unknown }).get;
  const value =
    typeof getter === 'function'
      ? getter.call(headers, name)
      : (headers as Record<string, unknown>)[name];
  if (value === undefined || value === null) {
    return undefined;
  }
  return Array.isArray(value) ? value.join(',') : String(value);
}
