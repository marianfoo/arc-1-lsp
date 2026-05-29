import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConnectivityProxy } from '../../../src/btp/connectivity.js';
import { lookupDestination } from '../../../src/btp/destination.js';
import { fetchClientCredentialsToken } from '../../../src/btp/token.js';
import type { BTPConfig } from '../../../src/btp/types.js';
import { parseVCAPServices } from '../../../src/btp/vcap.js';

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

const VCAP = JSON.stringify({
  xsuaa: [{ name: 'x', credentials: { url: 'https://uaa.example', clientid: 'xid', clientsecret: 'xsec' } }],
  destination: [
    {
      name: 'd',
      credentials: {
        uri: 'https://dest.example',
        clientid: 'did',
        clientsecret: 'dsec',
        token_service_url: 'https://dtok.example/oauth/token',
      },
    },
  ],
  connectivity: [
    {
      name: 'c',
      credentials: {
        onpremise_proxy_host: 'conn-proxy',
        onpremise_proxy_http_port: '20003',
        clientid: 'cid',
        clientsecret: 'csec',
        token_service_url: 'https://ctok.example',
      },
    },
  ],
});

describe('parseVCAPServices', () => {
  it('returns null off-BTP (VCAP_SERVICES unset)', () => {
    expect(parseVCAPServices({})).toBeNull();
  });
  it('parses xsuaa, destination, and connectivity bindings', () => {
    const c = parseVCAPServices({ VCAP_SERVICES: VCAP } as NodeJS.ProcessEnv) as BTPConfig;
    expect(c.connectivityProxyHost).toBe('conn-proxy');
    expect(c.connectivityProxyPort).toBe('20003');
    expect(c.destinationUrl).toBe('https://dest.example');
    expect(c.destinationTokenUrl).toBe('https://dtok.example/oauth/token');
    // connectivity token_service_url gets /oauth/token appended
    expect(c.connectivityTokenUrl).toBe('https://ctok.example/oauth/token');
    expect(c.xsuaaClientId).toBe('xid');
  });
});

describe('fetchClientCredentialsToken', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('returns access token + expiry', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'tok', expires_in: 3600 }));
    const r = await fetchClientCredentialsToken('https://t/oauth/token', 'id', 'sec');
    expect(r).toEqual({ accessToken: 'tok', expiresIn: 3600 });
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.body).toContain('grant_type=client_credentials');
  });
  it('throws on non-ok', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'bad' }, false, 401));
    await expect(fetchClientCredentialsToken('https://t', 'id', 'sec')).rejects.toThrow(/HTTP 401/);
  });
});

describe('createConnectivityProxy', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const cfg = parseVCAPServices({ VCAP_SERVICES: VCAP } as NodeJS.ProcessEnv) as BTPConfig;

  it('returns null when no connectivity proxy host', () => {
    expect(createConnectivityProxy({ ...cfg, connectivityProxyHost: '' })).toBeNull();
  });
  it('builds proxy config and caches the token across calls', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ access_token: 'ptok', expires_in: 3600 }));
    const proxy = createConnectivityProxy(cfg, 'LOC1');
    expect(proxy?.host).toBe('conn-proxy');
    expect(proxy?.port).toBe(20003);
    expect(proxy?.locationId).toBe('LOC1');
    const t1 = await proxy?.getProxyToken();
    const t2 = await proxy?.getProxyToken();
    expect(t1).toBe('ptok');
    expect(t2).toBe('ptok');
    expect(fetchMock).toHaveBeenCalledTimes(1); // cached
  });
});

describe('lookupDestination', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const cfg = parseVCAPServices({ VCAP_SERVICES: VCAP } as NodeJS.ProcessEnv) as BTPConfig;

  it('resolves a destination via the Destination Service', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: 'dtok', expires_in: 3600 })) // token
      .mockResolvedValueOnce(
        jsonResponse({
          destinationConfiguration: {
            Name: 'SAP_TRIAL',
            URL: 'http://a4h-virtual:50000',
            Authentication: 'BasicAuthentication',
            ProxyType: 'OnPremise',
            CloudConnectorLocationId: 'LOC1',
          },
        }),
      );
    const d = await lookupDestination(cfg, 'SAP_TRIAL');
    expect(d.Name).toBe('SAP_TRIAL');
    expect(d.ProxyType).toBe('OnPremise');
    expect(d.URL).toBe('http://a4h-virtual:50000');
    // second call hit the destination-configuration endpoint
    expect(fetchMock.mock.calls[1][0]).toContain('/destination-configuration/v1/destinations/SAP_TRIAL');
  });
  it('throws on non-ok destination lookup', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: 'dtok', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ error: 'not found' }, false, 404));
    await expect(lookupDestination(cfg, 'NOPE')).rejects.toThrow(/HTTP 404/);
  });
});
