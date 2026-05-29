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
