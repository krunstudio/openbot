import { selfHostedApiOrigin } from "@openbot/contracts/invite-links";
import { isMobileConnectDevelopmentHost } from "@openbot/contracts/mobile-connect";

export function buildContentSecurityPolicy(
  packaged: boolean,
  developmentSignalUrl?: string,
  selfHostedSignalOrigin?: string | null,
  selfHostedAuthOrigin?: string | null,
): string {
  const selfHostedSignalSource = selfHostedSignalOrigin ? ` ${selfHostedSignalOrigin}` : "";
  const selfHostedImageSource = selfHostedAuthOrigin?.startsWith("http://") ? ` ${selfHostedAuthOrigin}` : "";
  const developmentSources = packaged
    ? ""
    : ` http://localhost:* ws://localhost:*${developmentSignalSource(developmentSignalUrl)}`;
  const developmentImageSources = packaged ? "" : " http://127.0.0.1:* http://localhost:*";

  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: openbot-attachment: openbot-remote-attachment: openbot-avatar: openbot-remote-avatar: openbot-server-logo: openbot-remote-server-logo: https:${developmentImageSources}${selfHostedImageSource}`,
    "font-src 'self' data:",
    // The lightbox plays a recording from the attachment scheme, and the preview panel plays one
    // from an object URL of the bytes that the main process sent. Neither matches `default-src`.
    "media-src 'self' blob: openbot-attachment: openbot-remote-attachment:",
    `connect-src 'self' openbot-attachment: openbot-remote-attachment: https://analytics.openbot.run ws://127.0.0.1:* wss://*.openbot.run${selfHostedSignalSource}${developmentSources}`,
    "object-src 'none'",
    // The remote desktop viewer uses a loopback proxy in packaged apps too.
    "frame-src 'self' openbot-attachment: openbot-remote-attachment: openbot-visual: openbot-remote-visual: https://*.openbot.run http://127.0.0.1:* http://localhost:*",
    "base-uri 'none'",
  ].join("; ");
}

/**
 * The Signal origin of a self-hosted Account API. The Worker still chooses the URL in each ticket;
 * this only lets the peer window open it. It needs `OPENBOT_AUTH_API_URL`, because our Worker never
 * issues a ticket for another Signal.
 */
export function readSelfHostedSignalOrigin(
  authApiUrl: string | undefined,
  signalUrl: string | undefined,
): string | null {
  if (!signalUrl) {
    const authOrigin = selfHostedApiOrigin(authApiUrl);
    if (!authOrigin) return null;
    const parsedAuth = new URL(authOrigin);
    return `${parsedAuth.protocol === "https:" ? "wss:" : "ws:"}//${parsedAuth.hostname}:*`;
  }
  if (!authApiUrl) throw new Error("OPENBOT_REMOTE_SIGNAL_URL needs OPENBOT_AUTH_API_URL.");
  const url = new URL(signalUrl);
  const allowPlainWs = new URL(authApiUrl).protocol === "http:" || isMobileConnectDevelopmentHost(url.hostname);
  if (
    (url.protocol !== "wss:" && !(url.protocol === "ws:" && allowPlainWs)) ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error("OPENBOT_REMOTE_SIGNAL_URL must be a wss: URL without credentials.");
  }
  return url.origin;
}

function developmentSignalSource(value: string | undefined): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (
      url.protocol !== "ws:" ||
      !isMobileConnectDevelopmentHost(url.hostname) ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return "";
    }
    return ` ${url.origin}`;
  } catch {
    return "";
  }
}
