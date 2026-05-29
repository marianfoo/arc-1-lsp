/**
 * API-key edge auth (v1). Accepts `Authorization: Bearer <key>` or
 * `x-api-key: <key>`. Empty config disables auth (local dev) — the caller warns.
 * XSUAA is a later plan.
 */
export interface ApiKey {
  key: string;
  label?: string;
}

export function parseApiKeys(raw?: string): ApiKey[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.indexOf(':');
      return idx > 0 ? { key: entry.slice(0, idx), label: entry.slice(idx + 1) } : { key: entry };
    });
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function checkApiKey(
  headers: { authorization?: string | string[]; 'x-api-key'?: string | string[] },
  keys: ApiKey[],
): boolean {
  if (keys.length === 0) return true; // auth disabled
  const auth = header(headers.authorization);
  const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
  const presented = bearer ?? header(headers['x-api-key']);
  if (!presented) return false;
  return keys.some((k) => k.key === presented);
}
