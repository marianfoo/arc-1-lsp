/**
 * The arc-1-lsp MCP server (the "shell"). Reuses the ARC-1 shape — a small set
 * of intent tools — but every tool is backed by the embedded adt-ls engine, not
 * a hand-rolled ADT client. Foundation exposes two tools: `health` and
 * `list_destinations`.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Engine } from './engine.js';

function text(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  };
}

export function createMcpServer(engine: Engine): McpServer {
  const server = new McpServer({ name: 'arc-1-lsp', version: '0.0.1' });

  server.registerTool(
    'health',
    {
      description:
        'Report arc-1-lsp and embedded adt-ls health (adt-ls version, MCP port, up state). No SAP connection required.',
      inputSchema: {},
    },
    async () => text(engine.health()),
  );

  server.registerTool(
    'list_destinations',
    {
      description: 'List the available ABAP system destinations, federated from the embedded adt-ls.',
      inputSchema: {},
    },
    async () => text(await engine.callTool('abap_list_destinations', {})),
  );

  server.registerTool(
    'list_creatable_objects',
    {
      description:
        'List the ABAP object types creatable on a connected system (federated from adt-ls). Uses the startup-connected destination when `destination` is omitted. Exercises a real backend call.',
      inputSchema: {
        destination: z
          .string()
          .optional()
          .describe('Destination id; defaults to the destination connected at startup.'),
      },
    },
    async ({ destination }) => {
      const dest = destination ?? engine.connectedDestination;
      if (!dest) {
        return text(
          'No ABAP destination is connected. Configure ARC1_SAP_HOST/PORT/USER/PASSWORD, or pass `destination`.',
        );
      }
      return text(await engine.callTool('abap_creation-get_all_creatable_objects', { destination: dest }));
    },
  );

  server.registerTool(
    'search_objects',
    {
      description:
        'Search ABAP repository objects on the connected system by name pattern (e.g. "CL_ABAP*"). Returns name, type, description, and ADT uri for each hit.',
      inputSchema: {
        pattern: z.string().describe('Name pattern, e.g. "CL_ABAP_TYPEDESCR" or "ZCL_*".'),
        maxResults: z.number().int().positive().max(200).optional().describe('Max hits (default 50).'),
        types: z
          .array(z.string())
          .optional()
          .describe('Optional ADT object-type filter (e.g. ["CLAS/OC"]); empty = all types.'),
      },
    },
    async ({ pattern, maxResults, types }) => {
      if (!engine.connectedDestination) {
        return text('No ABAP destination is connected. Configure ARC1_SAP_* (see README).');
      }
      return text(await engine.search(pattern, { maxResults, types }));
    },
  );

  server.registerTool(
    'list_inactive_objects',
    {
      description: 'List inactive (draft) objects on the connected system — those edited but not yet activated.',
      inputSchema: {},
    },
    async () => {
      if (!engine.connectedDestination) {
        return text('No ABAP destination is connected. Configure ARC1_SAP_* (see README).');
      }
      return text(await engine.listInactiveObjects());
    },
  );

  server.registerTool(
    'list_users',
    {
      description: 'List the system users on the connected ABAP system (id + display name).',
      inputSchema: {},
    },
    async () => {
      if (!engine.connectedDestination) {
        return text('No ABAP destination is connected. Configure ARC1_SAP_* (see README).');
      }
      return text(await engine.listUsers());
    },
  );

  server.registerTool(
    'list_generators',
    {
      description:
        'List the object generators available on the connected system (e.g. RAP "OData UI Service") — what `generate_objects` can produce.',
      inputSchema: {},
    },
    async () => {
      const dest = engine.connectedDestination;
      if (!dest) return text('No ABAP destination is connected. Configure ARC1_SAP_* (see README).');
      return text(await engine.callTool('abap_generators-list_generators', { destination: dest }));
    },
  );

  server.registerTool(
    'get_generator_schema',
    {
      description:
        'Get the input schema for a specific object generator (use `generatorId` from list_generators). Read-only. ' +
        'Object-referencing generators (e.g. OData UI / Web-API service) also need `referencedObjectType` + `referencedObjectName`.',
      inputSchema: {
        generatorId: z.string().describe('Generator id from list_generators (e.g. "x-ui-service").'),
        package: z
          .string()
          .optional()
          .describe('Target package the schema is contextualized for (adt-ls requires one; default "$TMP").'),
        referencedObjectType: z
          .string()
          .optional()
          .describe('For generators built from an object: the referenced object type ("TABL", "DDLS", "BDEF", …).'),
        referencedObjectName: z
          .string()
          .optional()
          .describe('For generators built from an object: the referenced object name (e.g. "SCARR").'),
      },
    },
    async ({ generatorId, package: pkg, referencedObjectType, referencedObjectName }) => {
      const dest = engine.connectedDestination;
      if (!dest) return text('No ABAP destination is connected. Configure ARC1_SAP_* (see README).');
      // adt-ls's get_schema requires all of packageName + referencedObjectType + referencedObjectName
      // (the latter two may be ""); object-referencing generators (UI / Web-API service) need a real reference.
      return text(
        await engine.callTool('abap_generators-get_schema', {
          destination: dest,
          generatorId,
          packageName: pkg ?? '$TMP',
          referencedObjectType: referencedObjectType ?? '',
          referencedObjectName: referencedObjectName ?? '',
        }),
      );
    },
  );

  server.registerTool(
    'get_object_type_details',
    {
      description:
        'Describe the fields required to create an object of a given ADT type (e.g. "CLAS/OC") — read-only creation metadata.',
      inputSchema: {
        objectType: z.string().describe('ADT object type, e.g. "CLAS/OC", "DDLS/DF".'),
        name: z.string().optional().describe('Candidate object name (default placeholder).'),
      },
    },
    async ({ objectType, name }) => {
      const dest = engine.connectedDestination;
      if (!dest) return text('No ABAP destination is connected. Configure ARC1_SAP_* (see README).');
      return text(
        await engine.callTool('abap_creation-get_object_type_details', {
          destination: dest,
          objectType,
          name: name ?? 'Z_PLACEHOLDER',
        }),
      );
    },
  );

  server.registerTool(
    'get_service_binding',
    {
      description:
        'Inspect a published OData service binding (SRVB): binding type, OData version, published state, and service URIs. Find binding names via `search_objects` with types ["SRVB/SVB"].',
      inputSchema: {
        serviceBindingName: z.string().describe('Service binding name, e.g. "/DMO/API_TRAVEL_U_V2".'),
      },
    },
    async ({ serviceBindingName }) => {
      const dest = engine.connectedDestination;
      if (!dest) return text('No ABAP destination is connected. Configure ARC1_SAP_* (see README).');
      return text(
        await engine.callTool('abap_business_services-fetch_services', { destination: dest, serviceBindingName }),
      );
    },
  );

  // ── Authoring loop (pure adt-ls; modern ABAP-Cloud object types only) ──
  const objectType = z
    .string()
    .describe('ADT object type code, e.g. "CLAS/OC", "INTF/OI", "DDLS/DF" (modern ABAP-Cloud types).');
  const include = z
    .enum(['definitions', 'implementations', 'testclasses', 'macros'])
    .optional()
    .describe('Class local include to target; omit for the main source.');

  server.registerTool(
    'read_source',
    {
      description:
        'Read the source of an ABAP object by name + type (modern types: class/interface/CDS/…). Classic types (program/table/…) are not served by adt-ls headless — use main ARC-1 for those.',
      inputSchema: { name: z.string(), objectType, include },
    },
    async ({ name, objectType: t, include: inc }) =>
      text(await engine.lifecycle.readSource({ name, objectType: t, include: inc })),
  );

  server.registerTool(
    'create_object',
    {
      description: 'Create an ABAP object (mutating — requires ARC1_ALLOW_WRITES; package must be in the allowlist).',
      inputSchema: {
        objectType,
        name: z.string(),
        package: z.string().describe('Development package, e.g. "$TMP".'),
        description: z.string(),
      },
    },
    async ({ objectType: t, name, package: pkg, description }) =>
      text(await engine.lifecycle.createObject({ objectType: t, name, packageName: pkg, description })),
  );

  server.registerTool(
    'update_source',
    {
      description: "Replace an object's source (mutating — requires ARC1_ALLOW_WRITES). Source is plain ABAP text.",
      inputSchema: { name: z.string(), objectType, source: z.string(), include },
    },
    async ({ name, objectType: t, source, include: inc }) => {
      await engine.lifecycle.updateSource({ name, objectType: t, source, include: inc });
      return text({ updated: name });
    },
  );

  server.registerTool(
    'activate_object',
    {
      description:
        'Activate an object (mutating — requires ARC1_ALLOW_WRITES). Returns {success, diagnostics}; on syntax errors success is false with ranged diagnostics.',
      inputSchema: { name: z.string(), objectType },
    },
    async ({ name, objectType: t }) => text(await engine.lifecycle.activate({ name, objectType: t })),
  );

  server.registerTool(
    'run_unit_tests',
    {
      description: 'Run ABAP Unit tests for an object by name + type.',
      inputSchema: { name: z.string(), objectType },
    },
    async ({ name, objectType: t }) => text(await engine.lifecycle.runUnitTests({ name, objectType: t })),
  );

  server.registerTool(
    'delete_object',
    {
      description: 'Delete an ABAP object (mutating — requires ARC1_ALLOW_WRITES).',
      inputSchema: { name: z.string(), objectType },
    },
    async ({ name, objectType: t }) => {
      await engine.lifecycle.deleteObject({ name, objectType: t });
      return text({ deleted: name });
    },
  );

  return server;
}
