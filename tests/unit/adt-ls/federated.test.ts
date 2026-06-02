import { describe, expect, it } from 'vitest';
import { parseFederated } from '../../../src/adt-ls/federated.js';

describe('parseFederated', () => {
  it('prefers the parsed full text over a lossy structuredContent projection', () => {
    const r = parseFederated({
      content: [{ text: '{"a":1,"b":2}' }],
      structuredContent: { a: 1 }, // omits b (e.g. fetch_services omitting odataVersion)
      isError: false,
    });
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ a: 1, b: 2 });
    expect(r.text).toBe('{"a":1,"b":2}');
  });

  it('falls back to structuredContent when the text is not JSON', () => {
    const r = parseFederated({ content: [{ text: 'plain report' }], structuredContent: { ok: true } });
    expect(r.data).toEqual({ ok: true });
    expect(r.text).toBe('plain report');
  });

  it('falls back to the raw text when there is no structuredContent and text is not JSON', () => {
    const r = parseFederated({ content: [{ text: 'No tests found' }] });
    expect(r.data).toBe('No tests found');
  });

  it('parses a JSON-array text payload', () => {
    expect(parseFederated({ content: [{ text: '["A4H_001"]' }] }).data).toEqual(['A4H_001']);
  });

  it('marks ok=false on isError but still extracts the payload', () => {
    const r = parseFederated({ content: [{ text: 'object not found' }], isError: true });
    expect(r.ok).toBe(false);
    expect(r.data).toBe('object not found');
  });

  it('handles an empty / missing envelope without throwing', () => {
    expect(parseFederated({}).data).toBe('');
    expect(parseFederated(undefined).ok).toBe(true);
  });
});
