/**
 * API-key edge auth (v1). Accepts `Authorization: Bearer <key>` or
 * `x-api-key: <key>`. Empty config disables auth (local dev) — the caller warns.
 *
 * A key entry is `key`, `key:label`, or `key:<profile>` where profile ∈
 * {viewer,developer,admin} (ADR-0007). A bare key — or a non-profile label —
 * resolves to `developer` (back-compat: today any key = read+write). The
 * resolved `scopes` are not enforced per-tool yet (Stage 2 wires them into tool
 * handlers); XSUAA JWT is a later stage.
 */
import { type Profile, type Scope, isProfile, scopesForProfile } from '../authz/policy.js';

export interface ApiKey {
  key: string;
  label?: string;
  /** Resolved profile (default `developer` for bare keys / non-profile labels). */
  profile: Profile;
  /** Scopes granted by the profile (ADR-0007 Stage 2 enforces these). */
  scopes: Scope[];
}

export function parseApiKeys(raw?: string): ApiKey[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.indexOf(':');
      const key = idx > 0 ? entry.slice(0, idx) : entry;
      const suffix = idx > 0 ? entry.slice(idx + 1) : '';
      const profile: Profile = isProfile(suffix) ? suffix : 'developer';
      const apiKey: ApiKey = { key, profile, scopes: scopesForProfile(profile) };
      if (suffix) apiKey.label = suffix;
      return apiKey;
    });
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Resolve the presented credential to its configured key (with scopes), or null. */
export function resolveApiKey(
  headers: { authorization?: string | string[]; 'x-api-key'?: string | string[] },
  keys: ApiKey[],
): ApiKey | null {
  const auth = header(headers.authorization);
  const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
  const presented = bearer ?? header(headers['x-api-key']);
  if (!presented) return null;
  return keys.find((k) => k.key === presented) ?? null;
}

export function checkApiKey(
  headers: { authorization?: string | string[]; 'x-api-key'?: string | string[] },
  keys: ApiKey[],
): boolean {
  if (keys.length === 0) return true; // auth disabled
  return resolveApiKey(headers, keys) !== null;
}
