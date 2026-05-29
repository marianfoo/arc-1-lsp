import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/server/config.js';

describe('loadConfig (precedence: CLI > env > default)', () => {
  it('applies defaults', () => {
    const c = loadConfig([], {});
    expect(c).toMatchObject({ adtLsMcpPort: 2240, transport: 'stdio', httpPort: 8080 });
    expect(c.adtLsPath).toBeUndefined();
    expect(c.adtLsMcpToken).toBeUndefined();
  });

  it('env overrides defaults', () => {
    const c = loadConfig([], {
      ARC1_ADT_LS_MCP_PORT: '2250',
      ARC1_TRANSPORT: 'http-streamable',
      ARC1_ADT_LS_PATH: '/opt/adt-ls',
      ARC1_PORT: '9090',
    });
    expect(c.adtLsMcpPort).toBe(2250);
    expect(c.transport).toBe('http-streamable');
    expect(c.adtLsPath).toBe('/opt/adt-ls');
    expect(c.httpPort).toBe(9090);
  });

  it('CLI flags override env', () => {
    const c = loadConfig(['--adt-ls-mcp-port', '2260', '--transport', 'stdio'], {
      ARC1_ADT_LS_MCP_PORT: '2250',
      ARC1_TRANSPORT: 'http-streamable',
    });
    expect(c.adtLsMcpPort).toBe(2260);
    expect(c.transport).toBe('stdio');
  });

  it('falls back to CF $PORT when ARC1_PORT is unset (ARC1_PORT still wins)', () => {
    expect(loadConfig([], { PORT: '12345' }).httpPort).toBe(12345);
    expect(loadConfig([], { ARC1_PORT: '7777', PORT: '12345' }).httpPort).toBe(7777);
  });

  it('rejects an invalid transport', () => {
    expect(() => loadConfig([], { ARC1_TRANSPORT: 'ftp' })).toThrow(/Invalid transport/);
  });
});

describe('loadConfig — sapTarget', () => {
  const full = {
    ARC1_SAP_HOST: 'a4h.example.com',
    ARC1_SAP_PORT: '50001',
    ARC1_SAP_USER: 'DEVELOPER',
    ARC1_SAP_PASSWORD: 'secret',
  };

  it('is undefined when host/port/user/password are not all set', () => {
    expect(loadConfig([], {}).sapTarget).toBeUndefined();
    expect(loadConfig([], { ARC1_SAP_HOST: 'h', ARC1_SAP_PORT: '1' }).sapTarget).toBeUndefined();
    const { ARC1_SAP_PASSWORD, ...noPwd } = full;
    expect(loadConfig([], noPwd).sapTarget).toBeUndefined();
  });

  it('builds a target with defaults (destination SAP, client 001, EN, insecure true)', () => {
    const t = loadConfig([], full).sapTarget;
    expect(t).toEqual({
      destinationId: 'SAP',
      host: 'a4h.example.com',
      port: 50001,
      user: 'DEVELOPER',
      password: 'secret',
      client: '001',
      language: 'EN',
      insecure: true,
    });
  });

  it('honors overrides + insecure=false', () => {
    const t = loadConfig([], {
      ...full,
      ARC1_SAP_DESTINATION: 'A4H',
      ARC1_SAP_CLIENT: '100',
      ARC1_SAP_LANGUAGE: 'DE',
      ARC1_SAP_INSECURE: 'false',
    }).sapTarget;
    expect(t).toMatchObject({ destinationId: 'A4H', client: '100', language: 'DE', insecure: false });
  });

  it('CLI flags override env', () => {
    const t = loadConfig(['--sap-host', 'cli.host', '--sap-port', '443'], full).sapTarget;
    expect(t).toMatchObject({ host: 'cli.host', port: 443 });
  });
});

describe('loadConfig — write safety', () => {
  it('defaults: writes off, allowedPackages [$TMP]', () => {
    const c = loadConfig([], {});
    expect(c.allowWrites).toBe(false);
    expect(c.allowedPackages).toEqual(['$TMP']);
  });
  it('ARC1_ALLOW_WRITES + ARC1_ALLOWED_PACKAGES override', () => {
    const c = loadConfig([], { ARC1_ALLOW_WRITES: 'true', ARC1_ALLOWED_PACKAGES: '$TMP, ZARC*, ZTEST' });
    expect(c.allowWrites).toBe(true);
    expect(c.allowedPackages).toEqual(['$TMP', 'ZARC*', 'ZTEST']);
  });
  it('CLI flags override', () => {
    const c = loadConfig(['--allow-writes', 'true', '--allowed-packages', 'Z*'], {});
    expect(c.allowWrites).toBe(true);
    expect(c.allowedPackages).toEqual(['Z*']);
  });
});
