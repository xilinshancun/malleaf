export function assertRelayAppUrl(baseUrl: string): void {
  const url = new URL(baseUrl);
  const host = url.hostname.toLowerCase();
  if (
    !["http:", "https:"].includes(url.protocol) ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.startsWith("127.") ||
    host === "[::1]" ||
    host === "0.0.0.0"
  ) {
    throw new Error(
      "Relay pairing requires an explicitly configured app.baseUrl reachable from the other device. Malleaf's default local app URL cannot be used for remote pairing.",
    );
  }
}

export function assertRelayConfiguration(config: {
  relay?: { enabled?: boolean };
  app?: { baseUrl?: string };
}): void {
  if (config.relay?.enabled && config.app?.baseUrl) assertRelayAppUrl(config.app.baseUrl);
}
