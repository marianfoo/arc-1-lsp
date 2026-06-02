/**
 * Gated live END-TO-END smoke — drives (almost) every registered MCP tool through
 * the real MCP server (tool registration + Zod arg coercion + handler + engine)
 * against a real SAP system. Skips unless adt-ls is present AND ARC1_TEST_SAP_PASSWORD
 * is set (never in CI). Defaults to a4h. Mutates only $TMP and cleans up.
 *
 * Covers reads, code-intelligence, quality (ATC/coverage), the authoring loop, and
 * run_application — 35 of 39 tools. The 4 stateful/heavy mutators are NOT auto-run
 * (covered by unit tests, to avoid side effects on the shared system):
 *   - generate_objects   (orphans a full RAP service)
 *   - create_transport   (leaves a CTS request; no release/delete tool)
 *   - assign_transport   (needs a transportable object + a real TR)
 *   - publish_service_binding (toggles a real OData service's published state)
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveAdtLsPath } from '../../../src/adt-ls/discovery.js';
import { loadConfig } from '../../../src/server/config.js';
import { type Engine, startEngine } from '../../../src/server/engine.js';
import { createMcpServer } from '../../../src/server/server.js';

let binPath: string | null = null;
try {
  binPath = resolveAdtLsPath();
} catch {
  binPath = null;
}
const password = process.env.ARC1_TEST_SAP_PASSWORD;
const gated = !binPath || !password;

const CLS = 'ZCL_ARC1LSP_E2E';
const RUN = 'ZCL_ARC1LSP_E2ERUN';
const TYPE = 'CLAS/OC';
const SRC = `CLASS zcl_arc1lsp_e2e DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS get_value RETURNING VALUE(rv_value) TYPE i.
ENDCLASS.
CLASS zcl_arc1lsp_e2e IMPLEMENTATION.
  METHOD get_value.
    DATA lv_x TYPE i.
    lv_x = 42.
    rv_value = lv_x.
  ENDMETHOD.
ENDCLASS.`;
const RUN_MARKER = 'arc1lsp e2e ran';
const RUN_SRC = `CLASS zcl_arc1lsp_e2erun DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES if_oo_adt_classrun.
ENDCLASS.
CLASS zcl_arc1lsp_e2erun IMPLEMENTATION.
  METHOD if_oo_adt_classrun~main.
    out->write( |${RUN_MARKER}| ).
  ENDMETHOD.
ENDCLASS.`;

describe('ALL MCP tools — live e2e (needs adt-ls + ARC1_TEST_SAP_PASSWORD)', () => {
  let engine: Engine | undefined;
  afterAll(async () => {
    for (const n of [CLS, RUN]) {
      try {
        await engine?.lifecycle.deleteObject({ name: n, objectType: TYPE });
      } catch {
        /* already gone */
      }
    }
    await engine?.dispose();
  });

  it.skipIf(gated)(
    'every read / code-intel / quality / authoring / run tool works via the MCP server',
    async () => {
      const config = loadConfig([], {
        ARC1_SAP_HOST: process.env.ARC1_TEST_SAP_HOST ?? 'a4h.marianzeis.de',
        ARC1_SAP_PORT: process.env.ARC1_TEST_SAP_PORT ?? '50001',
        ARC1_SAP_USER: process.env.ARC1_TEST_SAP_USER ?? 'DEVELOPER',
        ARC1_SAP_PASSWORD: password,
        ARC1_SAP_DESTINATION: 'A4H',
        ARC1_ALLOW_WRITES: 'true',
        ARC1_ALLOWED_PACKAGES: '$TMP',
      });
      engine = await startEngine(config);
      const server = createMcpServer(engine);
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'e2e', version: '0' });
      await Promise.all([server.connect(st), client.connect(ct)]);

      // call a tool; throw (with the tool name) if it errors; return {text, json}.
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const r = (await client.callTool({ name, arguments: args })) as {
          isError?: boolean;
          structuredContent?: unknown;
          content?: Array<{ text?: string }>;
        };
        const text = r.content?.[0]?.text ?? '';
        if (r.isError) throw new Error(`tool ${name} errored: ${text.slice(0, 400)}`);
        let json: unknown;
        try {
          json = r.structuredContent ?? JSON.parse(text);
        } catch {
          json = undefined;
        }
        return { text, json };
      };
      const has = (name: string, args: Record<string, unknown>, re: RegExp) =>
        call(name, args).then((r) => expect(r.text, `${name} output`).toMatch(re));

      // the server exposes exactly the 39-tool surface
      const { tools } = await client.listTools();
      expect(tools.length).toBe(39);

      // ── connection-level reads ──
      await has('health', {}, /ADTLS/i);
      await has('list_destinations', {}, /A4H/i);
      await has('list_users', {}, /DEVELOPER/i);
      await has('list_creatable_objects', {}, /creatableObjects|objectType/);
      await has('list_generators', {}, /generators|OData/i);
      await has('search_objects', { pattern: 'CL_ABAP_TYPEDESCR' }, /CL_ABAP_TYPEDESCR/);
      await has('get_object_type_details', { objectType: 'CLAS/OC' }, /fields|tag/);
      expect(Array.isArray((await call('list_inactive_objects')).json)).toBe(true);
      // list_transports is now capped + shaped {total, returned, truncated, transports:[]}.
      expect(Array.isArray(((await call('list_transports')).json as { transports?: unknown[] }).transports)).toBe(true);
      await has('validate_object', { objectType: 'CLAS/OC', name: CLS, package: '$TMP', description: 'x' }, /\w/);
      await has(
        'find_transport',
        { objectName: CLS, objectType: 'CLAS/OC', developmentPackage: '$TMP', isCreation: true },
        /isRecordingRequired|transport/i,
      );

      // ── service-binding chain (read) ──
      // Federated reads now return the CLEAN payload (the doubly-wrapped envelope is
      // unwrapped by the `federated()` helper), incl. odataVersion (which the lossy
      // structuredContent omits — we prefer the full content text).
      const sb = (await call('get_service_binding', { serviceBindingName: '/DMO/API_TRAVEL_U_V2' })).json as {
        odataVersion: string;
        odataInfoUri: Array<{ href: string }>;
        services: Array<{ name: string; content: Array<{ serviceDefinition: string; serviceVersion: string }> }>;
      };
      expect(sb.odataVersion, 'unwrapped payload keeps odataVersion (not in structuredContent)').toBeTruthy();
      const svc = sb.services[0];
      await has(
        'get_service_details',
        {
          serviceBindingName: '/DMO/API_TRAVEL_U_V2',
          serviceName: svc.name,
          serviceDefinition: svc.content[0].serviceDefinition,
          serviceVersion: svc.content[0].serviceVersion,
          odataInfoUri: sb.odataInfoUri[0].href,
          odataVersion: sb.odataVersion,
        },
        /entitySet|odata|service/i,
      );
      await has('service_binding_details', { name: '/DMO/API_TRAVEL_U_V2' }, /ODATA|API_TRAVEL/);

      // ── authoring loop + code-intelligence on a fresh $TMP class ──
      await call('delete_object', { name: CLS, objectType: TYPE }).catch(() => {}); // clean slate
      await has('create_object', { objectType: TYPE, name: CLS, package: '$TMP', description: 'arc1lsp e2e' }, /\w/);
      await call('update_source', { name: CLS, objectType: TYPE, source: SRC });
      await has('read_source', { name: CLS, objectType: TYPE }, /get_value/i);
      await has('activate_object', { name: CLS, objectType: TYPE }, /"success": true/);
      await has('check_syntax', { name: CLS, objectType: TYPE }, /items/);
      await has('document_symbols', { name: CLS, objectType: TYPE }, /ZCL_ARC1LSP_E2E|GET_VALUE/i);
      await has('go_to_definition', { name: CLS, objectType: TYPE, symbol: 'GET_VALUE' }, /targetUri|range/);
      await has('go_to_declaration', { name: CLS, objectType: TYPE, symbol: 'GET_VALUE' }, /targetUri|range/);
      // where-used returns a Location[] — empty is correct for a fresh, never-called method.
      expect(
        Array.isArray((await call('find_references', { name: CLS, objectType: TYPE, symbol: 'GET_VALUE' })).json),
        'find_references returns an array',
      ).toBe(true);
      await has('hover', { name: CLS, objectType: TYPE, symbol: 'GET_VALUE' }, /get_value|method|VALUE/i);
      await has('document_highlight', { name: CLS, objectType: TYPE, symbol: 'GET_VALUE' }, /range|\[\]/);
      await has('type_hierarchy', { name: CLS, objectType: TYPE, symbol: CLS }, /item|ZCL_ARC1LSP_E2E/i);
      await has('completion', { name: CLS, objectType: TYPE, symbol: 'GET_VALUE' }, /items|total/);
      await has('get_lock_status', { name: CLS, objectType: TYPE }, /lockingSupported/);
      await has('run_unit_tests', { name: CLS, objectType: TYPE }, /no tests found|testClasses|durationCategory/i);
      await has('run_unit_tests_with_coverage', { name: CLS, objectType: TYPE }, /coverage|status|result/);
      await has('run_atc', { name: CLS, objectType: TYPE }, /atcRunCheckResults/);
      await has('list_atc_variants', { name: CLS, objectType: TYPE }, /checkVariants/);
      await call('delete_object', { name: CLS, objectType: TYPE });

      // ── run_application on a $TMP classrun class ──
      await call('delete_object', { name: RUN, objectType: TYPE }).catch(() => {});
      await call('create_object', { objectType: TYPE, name: RUN, package: '$TMP', description: 'arc1lsp e2e run' });
      await call('update_source', { name: RUN, objectType: TYPE, source: RUN_SRC });
      await call('activate_object', { name: RUN, objectType: TYPE });
      await has('run_application', { name: RUN, objectType: TYPE }, new RegExp(RUN_MARKER));
      await call('delete_object', { name: RUN, objectType: TYPE });
    },
    300000,
  );
});
