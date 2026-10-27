import http from 'node:http';
import { AddressInfo } from 'node:net';
import { Server as SocketIOServer } from 'socket.io';

/**
 * A request received by the mocked SPACE server.
 */
export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: http.IncomingHttpHeaders;
  body: any;
  rawBody: string;
}

/**
 * The response a route handler of the mocked SPACE server returns.
 */
export interface MockResponse {
  status: number;
  body?: any;
  headers?: Record<string, string>;
  /** Drop the connection without answering (a network error for the client). */
  destroy?: boolean;
}

type RouteHandler = (req: RecordedRequest) => MockResponse;

/**
 * A minimal in-process stand-in for SPACE: an HTTP server under `/api/v1` plus a Socket.IO server
 * mounted on `/events` (same path the real SPACE uses), so the client can be tested without a live
 * SPACE instance.
 */
export class MockSpace {
  public readonly requests: RecordedRequest[] = [];
  public io!: SocketIOServer;
  /**
   * Tokens sent as `X-Space-Capabilities` on every HTTP response (S0). `null` (the default) mimics a
   * SPACE that predates the header and sends none.
   */
  public capabilities: string[] | null = null;
  private server: http.Server;
  private routes: { method: string; path: string; handler: RouteHandler }[] = [];

  constructor() {
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  get url(): string {
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async start(): Promise<void> {
    this.io = new SocketIOServer(this.server, { path: '/events', transports: ['websocket'] });
    // SPACE always exposes the (unauthenticated) pricing events namespace.
    this.io.of('/pricings');
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', () => resolve()));
  }

  async stop(): Promise<void> {
    await new Promise<void>(resolve => this.io.close(() => resolve()));
    if (this.server.listening) {
      await new Promise<void>(resolve => this.server.close(() => resolve()));
    }
  }

  /**
   * Registers a handler for `method path`, where `path` is relative to `/api/v1` and excludes the
   * query string. Later registrations take precedence.
   */
  route(method: string, path: string, handler: RouteHandler | MockResponse): void {
    const fn = typeof handler === 'function' ? handler : () => handler;
    this.routes.unshift({ method: method.toUpperCase(), path, handler: fn });
  }

  reset(): void {
    this.routes = [];
    this.requests.length = 0;
    this.capabilities = null;
  }

  lastRequest(): RecordedRequest {
    return this.requests[this.requests.length - 1];
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let body: any = undefined;
      try {
        body = rawBody ? JSON.parse(rawBody) : undefined;
      } catch {
        body = rawBody;
      }
      const recorded: RecordedRequest = {
        method: req.method ?? 'GET',
        path: url.pathname.replace(/^\/api\/v1/, ''),
        query: url.searchParams,
        headers: req.headers,
        body,
        rawBody,
      };
      this.requests.push(recorded);

      const route = this.routes.find(r => r.method === recorded.method && r.path === recorded.path);
      const response: MockResponse = route
        ? route.handler(recorded)
        : { status: 404, body: { error: `No mock for ${recorded.method} ${recorded.path}` } };

      if (response.destroy) {
        req.socket.destroy();
        return;
      }

      const headers: Record<string, string> = { ...(response.headers ?? {}) };
      if (this.capabilities !== null && headers['x-space-capabilities'] === undefined) {
        headers['x-space-capabilities'] = this.capabilities.join(',');
      }
      let payload: string | undefined;
      if (response.body !== undefined) {
        if (typeof response.body === 'string') {
          payload = response.body;
        } else {
          payload = JSON.stringify(response.body);
          headers['content-type'] = headers['content-type'] ?? 'application/json';
        }
      }
      res.writeHead(response.status, headers);
      res.end(payload);
    });
  }
}
