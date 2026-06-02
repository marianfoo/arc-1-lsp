/**
 * Authorization scope model (ADR-0007, Stage 1). The single place that maps
 * tools → required scope and names → scope sets. BOTH the API-key edge (profiles)
 * and a future XSUAA JWT (Stage 2) feed into this; enforcement wiring into tool
 * handlers is Stage 2. Pure + dependency-free.
 *
 * Hierarchy: admin ⊇ transport ⊇ write ⊇ read. Kept deliberately small — adt-ls
 * has no SQL/data/git surface, so arc-1-lsp needs fewer scopes than main ARC-1.
 */
export type Scope = 'read' | 'write' | 'transport' | 'admin';

/** Expand granted scopes to their implied closure (admin ⊇ transport ⊇ write ⊇ read). */
export function expandScopes(granted: Iterable<Scope>): Set<Scope> {
  const out = new Set<Scope>();
  for (const s of granted) {
    out.add(s);
    if (s === 'admin') {
      out.add('transport');
      out.add('write');
      out.add('read');
    } else if (s === 'transport') {
      out.add('write');
      out.add('read');
    } else if (s === 'write') {
      out.add('read');
    }
  }
  return out;
}

/**
 * Required scope per tool. `null` = no scope required (always allowed, e.g.
 * health). Every registered tool MUST have an entry (a completeness test guards
 * this) so a new tool can't silently default to open.
 */
export const TOOL_SCOPES: Record<string, Scope | null> = {
  health: null,
  // reads
  list_destinations: 'read',
  list_creatable_objects: 'read',
  search_objects: 'read',
  list_inactive_objects: 'read',
  list_users: 'read',
  list_generators: 'read',
  get_generator_schema: 'read',
  get_object_type_details: 'read',
  get_service_binding: 'read',
  get_service_details: 'read',
  read_source: 'read',
  validate_object: 'read',
  find_transport: 'read',
  run_unit_tests: 'read',
  // LSP code-intelligence (all read-only)
  document_symbols: 'read',
  check_syntax: 'read',
  go_to_definition: 'read',
  go_to_declaration: 'read',
  hover: 'read',
  document_highlight: 'read',
  find_references: 'read',
  type_hierarchy: 'read',
  completion: 'read',
  // writes
  create_object: 'write',
  update_source: 'write',
  activate_object: 'write',
  delete_object: 'write',
  generate_objects: 'write',
  // transport
  create_transport: 'transport',
};

export type Profile = 'viewer' | 'developer' | 'admin';

/** Named API-key / role profiles → the scopes they grant. */
export const PROFILES: Record<Profile, Scope[]> = {
  viewer: ['read'],
  developer: ['read', 'write'],
  admin: ['admin'],
};

export function isProfile(name: string): name is Profile {
  return name === 'viewer' || name === 'developer' || name === 'admin';
}

export function scopesForProfile(name: Profile): Scope[] {
  return PROFILES[name];
}

/** True if the granted scopes (expanded) permit calling `tool`. Unknown tool → deny. */
export function hasToolAccess(granted: Iterable<Scope>, tool: string): boolean {
  if (!Object.hasOwn(TOOL_SCOPES, tool)) return false;
  const required = TOOL_SCOPES[tool];
  if (required === null) return true;
  return expandScopes(granted).has(required);
}
