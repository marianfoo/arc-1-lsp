/**
 * Connectivity proxy config (Cloud Connector hop). Ported from arc-1's
 * `src/adt/btp.ts` `createConnectivityProxy` — caches the connectivity JWT and
 * refreshes 60s before expiry.
 */
import { fetchClientCredentialsToken } from './token.js';
import type { BTPConfig, BTPProxyConfig } from './types.js';

export function createConnectivityProxy(btpConfig: BTPConfig, locationId?: string): BTPProxyConfig | null {
  if (!btpConfig.connectivityProxyHost) return null;

  let cachedToken = '';
  let expiresAt = 0;

  return {
    host: btpConfig.connectivityProxyHost,
    port: Number.parseInt(btpConfig.connectivityProxyPort || '20003', 10),
    protocol: 'http',
    locationId,
    getProxyToken: async () => {
      if (cachedToken && Date.now() < expiresAt) return cachedToken;
      const { accessToken, expiresIn } = await fetchClientCredentialsToken(
        btpConfig.connectivityTokenUrl,
        btpConfig.connectivityClientId,
        btpConfig.connectivitySecret,
      );
      cachedToken = accessToken;
      expiresAt = Date.now() + (expiresIn - 60) * 1000;
      return cachedToken;
    },
  };
}
