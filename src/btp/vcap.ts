/**
 * Parse VCAP_SERVICES → BTPConfig. Ported from arc-1's `src/adt/btp.ts`.
 * Returns null when not running on BTP (VCAP_SERVICES unset).
 */
import { logger } from '../server/logger.js';
import type { BTPConfig } from './types.js';

interface VCAPBinding {
  name: string;
  credentials: Record<string, unknown>;
}
interface VCAPServices {
  xsuaa?: VCAPBinding[];
  destination?: VCAPBinding[];
  connectivity?: VCAPBinding[];
}

export function parseVCAPServices(env: NodeJS.ProcessEnv = process.env): BTPConfig | null {
  const vcapJson = env.VCAP_SERVICES;
  if (!vcapJson) return null;

  const vcap: VCAPServices = JSON.parse(vcapJson);
  const config: BTPConfig = {
    xsuaaUrl: '',
    xsuaaClientId: '',
    xsuaaSecret: '',
    destinationUrl: '',
    destinationClientId: '',
    destinationSecret: '',
    destinationTokenUrl: '',
    connectivityProxyHost: '',
    connectivityProxyPort: '',
    connectivityClientId: '',
    connectivitySecret: '',
    connectivityTokenUrl: '',
  };

  if (vcap.xsuaa?.[0]?.credentials) {
    const c = vcap.xsuaa[0].credentials;
    config.xsuaaUrl = (c.url as string) || '';
    config.xsuaaClientId = (c.clientid as string) || '';
    config.xsuaaSecret = (c.clientsecret as string) || '';
  }

  if (vcap.destination?.[0]?.credentials) {
    const c = vcap.destination[0].credentials;
    config.destinationUrl = (c.uri as string) || (c.url as string) || '';
    config.destinationClientId = (c.clientid as string) || '';
    config.destinationSecret = (c.clientsecret as string) || '';
    config.destinationTokenUrl = (c.token_service_url as string) || '';
    if (!config.destinationTokenUrl && c.url) {
      config.destinationTokenUrl = `${(c.url as string).replace(/\/$/, '')}/oauth/token`;
    }
  }

  if (vcap.connectivity?.[0]?.credentials) {
    const c = vcap.connectivity[0].credentials;
    config.connectivityProxyHost = (c.onpremise_proxy_host as string) || '';
    config.connectivityProxyPort = (c.onpremise_proxy_http_port as string) || '';
    config.connectivityClientId = (c.clientid as string) || '';
    config.connectivitySecret = (c.clientsecret as string) || '';
    config.connectivityTokenUrl = (c.token_service_url as string) || '';
    if (!config.connectivityTokenUrl && c.url) {
      config.connectivityTokenUrl = `${(c.url as string).replace(/\/$/, '')}/oauth/token`;
    } else if (config.connectivityTokenUrl && !config.connectivityTokenUrl.endsWith('/oauth/token')) {
      config.connectivityTokenUrl = `${config.connectivityTokenUrl.replace(/\/$/, '')}/oauth/token`;
    }
  }

  logger.info(
    `BTP VCAP_SERVICES parsed: xsuaa=${!!config.xsuaaUrl} destination=${!!config.destinationUrl} connectivity=${!!config.connectivityProxyHost}`,
  );
  return config;
}
