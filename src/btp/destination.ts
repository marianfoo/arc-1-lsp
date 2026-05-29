/**
 * BTP Destination Service lookup (client-credentials, fixed-user path). Ported
 * from arc-1's `src/adt/btp.ts` `lookupDestination`. Per-user PP (the SAP Cloud
 * SDK + jwt-bearer exchange) is plan 05.
 */
import { logger } from '../server/logger.js';
import { fetchClientCredentialsToken } from './token.js';
import type { BTPConfig, Destination } from './types.js';

export async function lookupDestination(btpConfig: BTPConfig, destinationName: string): Promise<Destination> {
  const tokenUrl = btpConfig.destinationTokenUrl || `${btpConfig.xsuaaUrl}/oauth/token`;
  const { accessToken } = await fetchClientCredentialsToken(
    tokenUrl,
    btpConfig.destinationClientId,
    btpConfig.destinationSecret,
  );

  const destUrl = `${btpConfig.destinationUrl.replace(/\/$/, '')}/destination-configuration/v1/destinations/${encodeURIComponent(destinationName)}`;
  const resp = await fetch(destUrl, { headers: { Authorization: `Bearer ${accessToken}` } });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Destination Service returned HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }

  const data = (await resp.json()) as { destinationConfiguration: Destination };
  const d = data.destinationConfiguration;
  logger.info(
    `BTP destination resolved: name=${d.Name} url=${d.URL} auth=${d.Authentication} proxyType=${d.ProxyType} locationId=${d.CloudConnectorLocationId ?? ''}`,
  );
  return d;
}
