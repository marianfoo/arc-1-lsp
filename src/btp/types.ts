/**
 * BTP service-binding + destination types. Ported from arc-1's `src/adt/btp.ts`
 * (kept dependency-light + engine-agnostic so it can later become a shared
 * `@marianfoo/btp-connectivity` module consumed by both arc-1 and arc-1-lsp).
 */

/** BTP service binding credentials parsed from VCAP_SERVICES. */
export interface BTPConfig {
  xsuaaUrl: string;
  xsuaaClientId: string;
  xsuaaSecret: string;

  destinationUrl: string;
  destinationClientId: string;
  destinationSecret: string;
  destinationTokenUrl: string;

  connectivityProxyHost: string;
  connectivityProxyPort: string;
  connectivityClientId: string;
  connectivitySecret: string;
  connectivityTokenUrl: string;
}

/** Resolved destination from the BTP Destination Service. */
export interface Destination {
  Name: string;
  URL: string;
  Authentication: string;
  ProxyType: string;
  User?: string;
  Password?: string;
  'sap-client'?: string;
  /** Cloud Connector Location ID — routes to the correct SCC instance. */
  CloudConnectorLocationId?: string;
}

/** Connectivity proxy config for the bridge (Cloud Connector hop). */
export interface BTPProxyConfig {
  host: string;
  port: number;
  protocol: string;
  /** Fresh connectivity proxy JWT (cached, auto-refreshed). */
  getProxyToken: () => Promise<string>;
  /** Sent as the SAP-Connectivity-SCC-Location_ID header when set. */
  locationId?: string;
}
