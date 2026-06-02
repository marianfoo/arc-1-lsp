import { describe, expect, it } from 'vitest';
import {
  PROFILES,
  TOOL_SCOPES,
  expandScopes,
  hasToolAccess,
  isProfile,
  scopesForProfile,
} from '../../../src/authz/policy.js';

// The full registered tool surface (must match src/server/server.ts — also guarded
// by the sorted list in tests/unit/server/server.test.ts).
const ALL_TOOLS = [
  'health',
  'list_destinations',
  'list_creatable_objects',
  'search_objects',
  'list_inactive_objects',
  'list_users',
  'list_generators',
  'get_generator_schema',
  'get_object_type_details',
  'get_service_binding',
  'get_service_details',
  'read_source',
  'validate_object',
  'find_transport',
  'run_unit_tests',
  'create_object',
  'update_source',
  'activate_object',
  'delete_object',
  'generate_objects',
  'create_transport',
  'document_symbols',
  'check_syntax',
  'go_to_definition',
  'go_to_declaration',
  'hover',
  'document_highlight',
  'find_references',
  'type_hierarchy',
  'completion',
  'run_atc',
  'list_atc_variants',
  'run_unit_tests_with_coverage',
];

describe('expandScopes (admin ⊇ transport ⊇ write ⊇ read)', () => {
  it('admin implies every scope', () => {
    expect([...expandScopes(['admin'])].sort()).toEqual(['admin', 'read', 'transport', 'write']);
  });
  it('transport implies write + read', () => {
    expect([...expandScopes(['transport'])].sort()).toEqual(['read', 'transport', 'write']);
  });
  it('write implies read', () => {
    expect([...expandScopes(['write'])].sort()).toEqual(['read', 'write']);
  });
  it('read implies only read; empty → empty', () => {
    expect([...expandScopes(['read'])]).toEqual(['read']);
    expect([...expandScopes([])]).toEqual([]);
  });
});

describe('TOOL_SCOPES', () => {
  it('covers exactly the 33 registered tools (no tool silently un-scoped)', () => {
    expect(Object.keys(TOOL_SCOPES).sort()).toEqual([...ALL_TOOLS].sort());
  });
  it('LSP code-intelligence tools are read-scoped', () => {
    for (const t of [
      'document_symbols',
      'check_syntax',
      'go_to_definition',
      'go_to_declaration',
      'hover',
      'document_highlight',
      'find_references',
      'type_hierarchy',
      'completion',
    ]) {
      expect(TOOL_SCOPES[t]).toBe('read');
    }
  });
  it('every value is a valid scope or null', () => {
    for (const v of Object.values(TOOL_SCOPES)) {
      expect(v === null || ['read', 'write', 'transport', 'admin'].includes(v)).toBe(true);
    }
  });
  it('health is always-allowed; reads/writes/transport are scoped', () => {
    expect(TOOL_SCOPES.health).toBeNull();
    expect(TOOL_SCOPES.read_source).toBe('read');
    expect(TOOL_SCOPES.find_transport).toBe('read');
    expect(TOOL_SCOPES.create_object).toBe('write');
    expect(TOOL_SCOPES.generate_objects).toBe('write');
    expect(TOOL_SCOPES.create_transport).toBe('transport');
  });
});

describe('profiles', () => {
  it('viewer=read, developer=read+write, admin=admin', () => {
    expect(scopesForProfile('viewer')).toEqual(['read']);
    expect(scopesForProfile('developer')).toEqual(['read', 'write']);
    expect(scopesForProfile('admin')).toEqual(['admin']);
  });
  it('isProfile guards known names', () => {
    expect(isProfile('viewer')).toBe(true);
    expect(isProfile('admin')).toBe(true);
    expect(isProfile('dev')).toBe(false);
    expect(isProfile('')).toBe(false);
  });
});

describe('hasToolAccess', () => {
  it('viewer reads only', () => {
    expect(hasToolAccess(PROFILES.viewer, 'read_source')).toBe(true);
    expect(hasToolAccess(PROFILES.viewer, 'health')).toBe(true);
    expect(hasToolAccess(PROFILES.viewer, 'create_object')).toBe(false);
    expect(hasToolAccess(PROFILES.viewer, 'create_transport')).toBe(false);
  });
  it('developer reads + writes, but not transport', () => {
    expect(hasToolAccess(PROFILES.developer, 'read_source')).toBe(true);
    expect(hasToolAccess(PROFILES.developer, 'create_object')).toBe(true);
    expect(hasToolAccess(PROFILES.developer, 'generate_objects')).toBe(true);
    expect(hasToolAccess(PROFILES.developer, 'create_transport')).toBe(false);
  });
  it('admin does everything incl transport', () => {
    expect(hasToolAccess(PROFILES.admin, 'read_source')).toBe(true);
    expect(hasToolAccess(PROFILES.admin, 'create_object')).toBe(true);
    expect(hasToolAccess(PROFILES.admin, 'create_transport')).toBe(true);
  });
  it('denies an unknown tool even for admin', () => {
    expect(hasToolAccess(['admin'], 'definitely_not_a_tool')).toBe(false);
  });
});
