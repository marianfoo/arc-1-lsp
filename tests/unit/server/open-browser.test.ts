import { describe, expect, it } from 'vitest';
import { browserOpenCommand } from '../../../src/server/open-browser.js';

describe('browserOpenCommand', () => {
  it('macOS uses `open`', () => {
    expect(browserOpenCommand('https://x/y?a=1', 'darwin')).toEqual({ cmd: 'open', args: ['https://x/y?a=1'] });
  });
  it('Windows uses rundll32 FileProtocolHandler (URL as a true argv arg → `&`-safe, no shell)', () => {
    // a real reentrance URL with & query params must pass through verbatim
    const url = 'https://h/sap/bc/sec?sap-client=001&reentrance-ticket=ABC';
    expect(browserOpenCommand(url, 'win32')).toEqual({ cmd: 'rundll32', args: ['url.dll,FileProtocolHandler', url] });
  });
  it('Linux/other uses `xdg-open`', () => {
    expect(browserOpenCommand('https://x', 'linux')).toEqual({ cmd: 'xdg-open', args: ['https://x'] });
    expect(browserOpenCommand('https://x', 'freebsd').cmd).toBe('xdg-open');
  });
});
