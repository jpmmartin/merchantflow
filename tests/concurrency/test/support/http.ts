import { request, type IncomingHttpHeaders } from 'node:http';

/** A response as it arrived on the wire, with the socket that carried it. */
export interface HttpResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  /** The body text, exactly as received. */
  readonly text: string;
  /** Local port of the TCP connection, distinct for every request. */
  readonly localPort: number;
}

export interface HttpRequest {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

/**
 * Sends one request to `127.0.0.1:<port>` over a TCP connection of its own.
 * `agent: false` gives every request a one-time agent with the default options
 * (no keep-alive, no socket limit), so no request waits for another's socket
 * and none reuses one: concurrent calls are concurrent connections.
 */
export function send(port: number, call: HttpRequest): Promise<HttpResponse> {
  const payload =
    call.body === undefined ? undefined : JSON.stringify(call.body);
  return new Promise((resolve, reject) => {
    let localPort = 0;
    const outgoing = request(
      {
        host: '127.0.0.1',
        port,
        method: call.method,
        path: call.path,
        agent: false,
        headers: {
          ...(payload === undefined
            ? {}
            : {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload).toString(),
              }),
          ...call.headers,
        },
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.on('error', reject);
        incoming.on('end', () => {
          resolve({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            text: Buffer.concat(chunks).toString('utf8'),
            localPort,
          });
        });
      },
    );
    outgoing.on('socket', (socket) => {
      socket.on('connect', () => {
        localPort = socket.localPort ?? 0;
      });
    });
    outgoing.on('error', reject);
    outgoing.end(payload);
  });
}
