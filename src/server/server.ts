/**
 * The arc-1-lsp MCP server (the "shell"). Reuses the ARC-1 shape — a small set
 * of intent tools — but every tool is backed by the embedded adt-ls engine, not
 * a hand-rolled ADT client. Foundation exposes two tools: `health` and
 * `list_destinations`.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { VERSION } from '../version.js';
import type { Engine } from './engine.js';

function text(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  };
}

export function createMcpServer(engine: Engine): McpServer {
  const server = new McpServer({ name: 'arc-1-lsp', version: VERSION });

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

  // ── Generation, validation & transport (pure adt-ls) ──
  server.registerTool(
    'generate_objects',
    {
      description:
        'Run a RAP object generator (from list_generators) — scaffolds a full RAP service (table/CDS/behavior/service definition+binding) into a package (mutating — requires ARC1_ALLOW_WRITES; package must be allowed). `content` is the JSON matching get_generator_schema. Object-referencing generators (OData UI / Web-API service) also need referencedObjectType + referencedObjectName. For transportable (non-$TMP) packages, pass a transport from find_transport/create_transport.',
      inputSchema: {
        generatorId: z.string().describe('Generator id from list_generators (e.g. "x-ui-service").'),
        content: z.string().describe('JSON string matching the get_generator_schema structure.'),
        package: z.string().describe('Target development package, e.g. "$TMP".'),
        transport: z.string().optional().describe('CTS transport number for non-$TMP packages; omit for local.'),
        referencedObjectType: z
          .string()
          .optional()
          .describe('For object-built generators: referenced object type ("TABL", "DDLS", "BDEF", …).'),
        referencedObjectName: z.string().optional().describe('For object-built generators: referenced object name.'),
      },
    },
    async ({ generatorId, content, package: pkg, transport, referencedObjectType, referencedObjectName }) =>
      text(
        await engine.lifecycle.generateObjects({
          generatorId,
          content,
          packageName: pkg,
          transportRequestNumber: transport,
          referencedObjectType,
          referencedObjectName,
        }),
      ),
  );

  server.registerTool(
    'validate_object',
    {
      description:
        'Validate object-creation input before create_object (read-only). Mirrors create_object inputs; returns the validation verdict (including whether a transport is required for the package).',
      inputSchema: {
        objectType,
        name: z.string(),
        package: z.string().describe('Development package, e.g. "$TMP".'),
        description: z.string(),
      },
    },
    async ({ objectType: t, name, package: pkg, description }) =>
      text(await engine.lifecycle.validateObject({ objectType: t, name, packageName: pkg, description })),
  );

  server.registerTool(
    'find_transport',
    {
      description:
        'Find the transport request(s) relevant to creating/changing ONE ABAP object (read-only; object-scoped, not a system transport list). Call before create_object/generate_objects for transportable packages; for $TMP no transport is needed.',
      inputSchema: {
        objectName: z.string(),
        objectType,
        developmentPackage: z.string().describe('Development package the object lives in.'),
        isCreation: z.boolean().describe('true if the object is being created; false if modified/deleted.'),
      },
    },
    async ({ objectName, objectType: t, developmentPackage, isCreation }) =>
      text(await engine.lifecycle.findTransport({ objectName, objectType: t, developmentPackage, isCreation })),
  );

  server.registerTool(
    'create_transport',
    {
      description:
        'Create a CTS transport request (mutating — requires ARC1_ALLOW_WRITES + ARC1_ALLOW_TRANSPORT_WRITES). Use find_transport first to check whether a new transport is actually needed.',
      inputSchema: {
        developmentPackage: z.string().describe('Development package the transport is for.'),
        transportDescription: z.string().describe('Short description (like a git commit subject).'),
        isCreation: z.boolean().describe('true if creating the object; false if modifying.'),
        objectName: z.string().optional(),
        objectType: z.string().optional(),
      },
    },
    async ({ developmentPackage, transportDescription, isCreation, objectName, objectType: t }) =>
      text(
        await engine.lifecycle.createTransport({
          developmentPackage,
          transportDescription,
          isCreation,
          objectName,
          objectType: t,
        }),
      ),
  );

  server.registerTool(
    'get_service_details',
    {
      description:
        'Fetch OData service details (URL, entity sets, navigations) for ONE service of a binding. Its inputs are taken from get_service_binding output (the service list). Read-only.',
      inputSchema: {
        serviceBindingName: z.string(),
        serviceName: z.string(),
        serviceDefinition: z.string(),
        serviceVersion: z.string(),
        odataInfoUri: z.string().describe('odataInfoUri from get_service_binding output.'),
        odataVersion: z.string().describe('OData version, "V2" or "V4".'),
        isPublished: z.boolean().optional(),
      },
    },
    async (args) => {
      const dest = engine.connectedDestination;
      if (!dest) return text('No ABAP destination is connected. Configure ARC1_SAP_* (see README).');
      return text(
        await engine.callTool('abap_business_services-fetch_service_information', { destination: dest, ...args }),
      );
    },
  );

  // ── LSP code-intelligence (adt-ls is a language server; pure textDocument/*) ──
  // Position-based tools: target a declared `symbol` by name (resolved via the
  // outline), or pass explicit 1-based `line` + `character`. Modern types only
  // (same boundary as read_source). All read-only.
  const symbolArg = z
    .string()
    .optional()
    .describe('Declared symbol to target (class/method/attribute/type/interface name), resolved to its position.');
  const lineArg = z
    .number()
    .int()
    .positive()
    .optional()
    .describe('1-based line (use with `character` instead of `symbol`).');
  const charArg = z.number().int().positive().optional().describe('1-based character/column (use with `line`).');

  server.registerTool(
    'document_symbols',
    {
      description:
        'Outline an ABAP object — classes, interfaces, methods, attributes, types — with their source ranges (LSP documentSymbol). Use this to find symbol positions for the other navigation tools.',
      inputSchema: { name: z.string(), objectType },
    },
    async ({ name, objectType: t }) => text(await engine.navigation.documentSymbols({ name, objectType: t })),
  );

  server.registerTool(
    'check_syntax',
    {
      description:
        'Run the ABAP syntax check on an object WITHOUT activating it (LSP pull diagnostics — the same check ADT runs). Returns diagnostics with ranges; empty = clean.',
      inputSchema: { name: z.string(), objectType },
    },
    async ({ name, objectType: t }) => text(await engine.navigation.checkSyntax({ name, objectType: t })),
  );

  server.registerTool(
    'go_to_definition',
    {
      description:
        "Resolve where a symbol is defined (LSP definition). Target a declared `symbol` by name, or pass 1-based `line`+`character` for any identifier in the object's source.",
      inputSchema: { name: z.string(), objectType, symbol: symbolArg, line: lineArg, character: charArg },
    },
    async ({ name, objectType: t, symbol, line, character }) =>
      text(await engine.navigation.goToDefinition({ name, objectType: t }, { symbol, line, character })),
  );

  server.registerTool(
    'find_references',
    {
      description:
        'Find where a symbol is used (LSP references / where-used). Target a declared `symbol` by name or 1-based `line`+`character`. Heavily-used global symbols (e.g. a kernel class) can time out — narrow to a local or less-referenced symbol.',
      inputSchema: {
        name: z.string(),
        objectType,
        symbol: symbolArg,
        line: lineArg,
        character: charArg,
        includeDeclaration: z
          .boolean()
          .optional()
          .describe('Include the declaration itself in the results (default true).'),
      },
    },
    async ({ name, objectType: t, symbol, line, character, includeDeclaration }) =>
      text(
        await engine.navigation.findReferences(
          { name, objectType: t },
          { symbol, line, character },
          { includeDeclaration },
        ),
      ),
  );

  server.registerTool(
    'type_hierarchy',
    {
      description:
        'Show the inheritance / implementation tree of a class or interface (LSP type hierarchy): supertypes and/or subtypes, including method implementations across implementing classes. Target the type by `symbol` name or 1-based `line`+`character`.',
      inputSchema: {
        name: z.string(),
        objectType,
        symbol: symbolArg,
        line: lineArg,
        character: charArg,
        direction: z
          .enum(['supertypes', 'subtypes', 'both'])
          .optional()
          .describe('Which direction to expand (default both).'),
      },
    },
    async ({ name, objectType: t, symbol, line, character, direction }) =>
      text(await engine.navigation.typeHierarchy({ name, objectType: t }, { symbol, line, character }, { direction })),
  );

  server.registerTool(
    'completion',
    {
      description:
        'Code-completion proposals at a position (LSP completion) — keywords, types, methods in context. Target by `symbol` name or 1-based `line`+`character`. Results are capped (`maxItems`).',
      inputSchema: {
        name: z.string(),
        objectType,
        symbol: symbolArg,
        line: lineArg,
        character: charArg,
        maxItems: z.number().int().positive().max(200).optional().describe('Max items to return (default 50).'),
      },
    },
    async ({ name, objectType: t, symbol, line, character, maxItems }) =>
      text(await engine.navigation.completion({ name, objectType: t }, { symbol, line, character }, { maxItems })),
  );

  server.registerTool(
    'go_to_declaration',
    {
      description:
        'Resolve where a symbol is declared (LSP declaration). For ABAP this is the DEFINITION/signature site (vs go_to_definition → the implementation). Target a declared `symbol` by name, or pass 1-based `line`+`character`.',
      inputSchema: { name: z.string(), objectType, symbol: symbolArg, line: lineArg, character: charArg },
    },
    async ({ name, objectType: t, symbol, line, character }) =>
      text(await engine.navigation.goToDeclaration({ name, objectType: t }, { symbol, line, character })),
  );

  server.registerTool(
    'hover',
    {
      description:
        "Hover info for the symbol at a position (LSP hover): for ABAP a full method/class signature + ABAP-Doc short text as markdown; for CDS the element info. Target a declared `symbol` by name, or pass 1-based `line`+`character`. Returns null when there's nothing under the cursor.",
      inputSchema: { name: z.string(), objectType, symbol: symbolArg, line: lineArg, character: charArg },
    },
    async ({ name, objectType: t, symbol, line, character }) =>
      text(await engine.navigation.hover({ name, objectType: t }, { symbol, line, character })),
  );

  server.registerTool(
    'document_highlight',
    {
      description:
        'Highlight all occurrences of the symbol at a position within the same object (LSP documentHighlight) — each with a read/write/text kind. Target a declared `symbol` by name, or pass 1-based `line`+`character`.',
      inputSchema: { name: z.string(), objectType, symbol: symbolArg, line: lineArg, character: charArg },
    },
    async ({ name, objectType: t, symbol, line, character }) =>
      text(await engine.navigation.documentHighlight({ name, objectType: t }, { symbol, line, character })),
  );

  // ── Quality & test (ATC static analysis, ABAP Unit coverage; pure adt-ls, read-only) ──
  server.registerTool(
    'run_atc',
    {
      description:
        'Run ABAP Test Cockpit (ATC) static analysis on an object — SAP-native checks for security, performance, naming, cloud-readiness, etc. (complements check_syntax). Omit `checkVariant` to use the system default. Findings carry priority, message, checkId, and line. Returns no findings if the backend has no ATC check variant configured (see list_atc_variants).',
      inputSchema: {
        name: z.string(),
        objectType,
        checkVariant: z.string().optional().describe('ATC check-variant name; omit to use the system default variant.'),
      },
    },
    async ({ name, objectType: t, checkVariant }) =>
      text(await engine.quality.runAtc({ name, objectType: t }, { checkVariant })),
  );

  server.registerTool(
    'list_atc_variants',
    {
      description:
        'List the ATC check variants configured on the system (name → description). An empty result means none are configured (run_atc then uses the system default). `query` filters the list.',
      inputSchema: {
        name: z.string(),
        objectType,
        query: z.string().optional().describe('Filter the variant list by name fragment.'),
      },
    },
    async ({ name, objectType: t, query }) =>
      text(await engine.quality.listAtcVariants({ name, objectType: t }, { query })),
  );

  server.registerTool(
    'run_unit_tests_with_coverage',
    {
      description:
        'Run ABAP Unit tests for an object WITH code coverage — returns the test result plus statement/branch/procedure coverage counts (covered/total) per object. Coverage is null when the object has no tests. Read-only.',
      inputSchema: { name: z.string(), objectType },
    },
    async ({ name, objectType: t }) => text(await engine.quality.runUnitTestsWithCoverage({ name, objectType: t })),
  );

  // ── Runtime & business services (pure adt-ls) ──
  server.registerTool(
    'run_application',
    {
      description:
        'Run an executable ABAP object and return its console output — a class implementing if_oo_adt_classrun (the "ABAP Application (Console)" run target) or an executable program. Executes ABAP (governed by your SAP authorizations); the object must support console run, else adt-ls reports it is not supported.',
      inputSchema: { name: z.string(), objectType },
    },
    async ({ name, objectType: t }) => text(await engine.services.runApplication({ name, objectType: t })),
  );

  server.registerTool(
    'service_binding_details',
    {
      description:
        'Read a service binding (SRVB) via the native srvb segment: binding type, OData version, the bound services, and full object data. Read-only. (Complements get_service_binding with native object data.)',
      inputSchema: { name: z.string().describe('Service binding name, e.g. "/DMO/API_TRAVEL_U_V2".') },
    },
    async ({ name }) => text(await engine.services.serviceBindingDetails({ name, objectType: 'SRVB/SVB' })),
  );

  server.registerTool(
    'publish_service_binding',
    {
      description:
        'Publish (or unpublish) a service binding — makes its OData service live (mutating — requires ARC1_ALLOW_WRITES). adt-ls TOGGLES based on the current published state, so calling it on a published binding unpublishes it. Returns {isExecuted, isPublishSuccess, statusMessage}.',
      inputSchema: { name: z.string().describe('Service binding name, e.g. "/DMO/API_TRAVEL_U_V2".') },
    },
    async ({ name }) => text(await engine.services.publishServiceBinding({ name, objectType: 'SRVB/SVB' })),
  );

  return server;
}
