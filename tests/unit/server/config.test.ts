import { describe, expect, it } from 'vitest';
import { detectLegacySapEnvWarnings, loadConfig } from '../../../src/server/config.js';

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

  it('builds a target with defaults (destination SAP, client 001, EN, insecure true, basic auth)', () => {
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
      authMode: 'basic',
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

  it('defaults to basic auth', () => {
    expect(loadConfig([], full).sapTarget?.authMode).toBe('basic');
  });

  it('sso mode needs only host+port (no password); user is an optional hint', () => {
    const t = loadConfig([], { ARC1_SAP_HOST: 'a4h', ARC1_SAP_PORT: '50001', ARC1_SAP_AUTH: 'sso' }).sapTarget;
    expect(t).toMatchObject({ host: 'a4h', port: 50001, authMode: 'sso', user: '', password: '' });
    const withHint = loadConfig([], {
      ARC1_SAP_HOST: 'a4h',
      ARC1_SAP_PORT: '50001',
      ARC1_SAP_AUTH: 'sso',
      ARC1_SAP_USER: 'MARIAN',
    }).sapTarget;
    expect(withHint).toMatchObject({ authMode: 'sso', user: 'MARIAN' });
  });

  it('basic requires a password but sso does not', () => {
    const hp = { ARC1_SAP_HOST: 'a4h', ARC1_SAP_PORT: '50001' };
    expect(loadConfig([], hp).sapTarget).toBeUndefined(); // basic + no password
    expect(loadConfig([], { ...hp, ARC1_SAP_AUTH: 'sso' }).sapTarget).toBeDefined();
  });

  it('--sap-auth selects sso (CLI)', () => {
    const t = loadConfig(['--sap-auth', 'sso'], { ARC1_SAP_HOST: 'a4h', ARC1_SAP_PORT: '50001' }).sapTarget;
    expect(t?.authMode).toBe('sso');
  });
});

describe('loadConfig — write safety', () => {
  it('defaults: writes off, transport-writes off, allowedPackages [$TMP]', () => {
    const c = loadConfig([], {});
    expect(c.allowWrites).toBe(false);
    expect(c.allowTransportWrites).toBe(false);
    expect(c.allowedPackages).toEqual(['$TMP']);
  });
  it('ARC1_ALLOW_WRITES + ARC1_ALLOWED_PACKAGES override', () => {
    const c = loadConfig([], { ARC1_ALLOW_WRITES: 'true', ARC1_ALLOWED_PACKAGES: '$TMP, ZARC*, ZTEST' });
    expect(c.allowWrites).toBe(true);
    expect(c.allowedPackages).toEqual(['$TMP', 'ZARC*', 'ZTEST']);
  });
  it('ARC1_ALLOW_TRANSPORT_WRITES toggles transport writes (env + CLI)', () => {
    expect(loadConfig([], { ARC1_ALLOW_TRANSPORT_WRITES: 'true' }).allowTransportWrites).toBe(true);
    expect(loadConfig(['--allow-transport-writes', 'true'], {}).allowTransportWrites).toBe(true);
  });
  it('CLI flags override', () => {
    const c = loadConfig(['--allow-writes', 'true', '--allowed-packages', 'Z*'], {});
    expect(c.allowWrites).toBe(true);
    expect(c.allowedPackages).toEqual(['Z*']);
  });
});

describe('detectLegacySapEnvWarnings (SAP_* → ARC1_* migration)', () => {
  it('returns nothing when no legacy SAP_* vars are set', () => {
    expect(detectLegacySapEnvWarnings({})).toEqual([]);
    expect(detectLegacySapEnvWarnings({ ARC1_ALLOW_WRITES: 'true', ARC1_SAP_USER: 'X' })).toEqual([]);
  });

  it('warns when a SAP_* var is set but its ARC1_* twin is not', () => {
    const w = detectLegacySapEnvWarnings({ SAP_ALLOW_TRANSPORT_WRITES: 'true' });
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('SAP_ALLOW_TRANSPORT_WRITES');
    expect(w[0]).toContain('ARC1_ALLOW_TRANSPORT_WRITES');
    expect(w[0]).toMatch(/ignored/);
  });

  it('stays silent when both the legacy var AND its modern twin are set (twin wins)', () => {
    expect(detectLegacySapEnvWarnings({ SAP_ALLOW_WRITES: 'true', ARC1_ALLOW_WRITES: 'false' })).toEqual([]);
  });

  it('reports each unmigrated var (writes, packages, connection)', () => {
    const w = detectLegacySapEnvWarnings({
      SAP_ALLOW_WRITES: 'true',
      SAP_ALLOWED_PACKAGES: 'Z*',
      SAP_USER: 'DEVELOPER',
      SAP_PASSWORD: 'x',
    });
    expect(w).toHaveLength(4);
    expect(w.join('\n')).toContain('ARC1_ALLOWED_PACKAGES');
    expect(w.join('\n')).toContain('ARC1_SAP_USER');
  });
});
