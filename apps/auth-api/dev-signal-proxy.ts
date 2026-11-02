import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { Plugin } from "vite";

/**
 * Local development only. Proxies HTTP requests and WebSocket upgrades targeting `/v1/signal`
 * directly to the local Signal service (port 3101 by default).
 *
 * This ensures browser clients and phones accessing OpenBot through an HTTPS reverse proxy
 * (or Cloudflare Tunnel routed to the Vite dev server port 3100) reach the Signal server
 * instead of falling through to TanStack Start's 404 handler.
 */
function requestUrl(request: IncomingMessage): string {
  if ("originalUrl" in request && typeof request.originalUrl === "string") {
    return request.originalUrl;
  }
  return request.url ?? "/v1/signal";
}

export function developmentSignalProxy(): Plugin {
  return {
    name: "openbot-development-signal-proxy",
    apply: "serve",
    configureServer(server) {
      const getSignalPort = (): number => {
        const envPort = process.env.REMOTE_SIGNAL_PORT;
        if (envPort && /^\d+$/u.test(envPort)) return Number(envPort);
        return 3_101;
      };

      // 1. Intercept HTTP requests before TanStack Start router
      server.middlewares.use("/v1/signal", (request: IncomingMessage, response: ServerResponse) => {
        const signalPort = getSignalPort();
        const url = requestUrl(request);
        const proxyReq = http.request(
          {
            hostname: "127.0.0.1",
            port: signalPort,
            path: url,
            method: request.method,
            headers: {
              ...request.headers,
              host: `127.0.0.1:${signalPort}`,
            },
          },
          (proxyRes) => {
            response.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
            proxyRes.pipe(response);
          },
        );
        proxyReq.on("error", () => {
          response.statusCode = 502;
          response.end();
        });
        request.pipe(proxyReq);
      });

      // 2. Intercept WebSocket upgrades on Node HTTP server
      server.httpServer?.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
        const url = request.url ?? "";
        if (!url.startsWith("/v1/signal")) return;

        const signalPort = getSignalPort();
        const proxyReq = http.request({
          hostname: "127.0.0.1",
          port: signalPort,
          path: url,
          method: request.method,
          headers: {
            ...request.headers,
            host: `127.0.0.1:${signalPort}`,
          },
        });

        proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
          socket.write(`HTTP/${proxyRes.httpVersion} ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`);
          for (let i = 0; i < proxyRes.rawHeaders.length; i += 2) {
            socket.write(`${proxyRes.rawHeaders[i]}: ${proxyRes.rawHeaders[i + 1]}\r\n`);
          }
          socket.write("\r\n");
          if (proxyHead && proxyHead.length > 0) socket.write(proxyHead);
          if (head && head.length > 0) proxySocket.write(head);
          proxySocket.pipe(socket);
          socket.pipe(proxySocket);
        });

        proxyReq.on("error", () => {
          socket.destroy();
        });

        request.pipe(proxyReq);
      });
    },
  };
}
