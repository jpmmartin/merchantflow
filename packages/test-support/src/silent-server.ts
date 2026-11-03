import { createServer, type Socket } from 'node:net';

export interface SilentServer {
  readonly port: number;
  stop(): Promise<void>;
}

// Starts a TCP server on the loopback interface that accepts connections and
// never answers. A client that waits for a handshake from it behaves as if the
// peer were unreachable, which no connection-refused error reproduces.
export function startSilentServer(): Promise<SilentServer> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('The silent server has no TCP address.'));
        return;
      }
      resolve({
        port: address.port,
        stop: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) {
              socket.destroy();
            }
            server.close(() => done());
          }),
      });
    });
  });
}
