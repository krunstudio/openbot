/**
 * The Signal URL that the host peer dials. A dev or self-host stack runs Signal on this computer and
 * publishes it to the account service as `REMOTE_SIGNAL_URL`, which can name a LAN address or a
 * public name that this computer cannot reach itself. When a ticket names that published Signal,
 * the host dials it on loopback, which the renderer CSP always allows. Other tickets keep their URL.
 */
export function localHostSignalUrl(signalUrl: string, environment: NodeJS.ProcessEnv = process.env): string {
  const published = environment.REMOTE_SIGNAL_URL?.trim();
  const port = environment.REMOTE_SIGNAL_PORT?.trim();
  if (!published || !port || !/^\d{1,5}$/u.test(port)) return signalUrl;
  try {
    const ticket = new URL(signalUrl);
    if (ticket.host !== new URL(published).host) return signalUrl;
    ticket.protocol = "ws:";
    ticket.host = `127.0.0.1:${port}`;
    return ticket.toString();
  } catch {
    return signalUrl;
  }
}
