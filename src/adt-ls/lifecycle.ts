import { type WriteSafety, assertWriteAllowed } from '../server/safety.js';
/**
 * The ABAP object authoring lifecycle, pure adt-ls (ADR-0003): resolve an object
 * by name → repotree AFF URI, then read / create / update / activate / test /
 * delete. Mutations go through the write-safety layer. Only the modern ABAP-Cloud
 * object types adt-ls serves headless work; classic types surface a clear error.
 * See docs/adt-ls-reference.md.
 */
import type { LspRequester } from './driver.js';
import {
  deleteFile,
  getLsUri,
  includeAffUri,
  isUnsupportedPlaceholder,
  metadataAffUri,
  quickSearch,
  readFile,
  writeFile,
} from './repository.js';

export interface ObjectRef {
  name: string;
  /** ADT type code, e.g. "CLAS/OC", "INTF/OI", "DDLS/DF". */
  objectType: string;
}
export interface ActivateResult {
  success: boolean;
  diagnostics: unknown[];
}
export interface CreateResult {
  message?: string;
  filePath?: string;
}

export interface LifecycleDeps {
  driver: LspRequester;
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  /** The connected destination id, or undefined. */
  destination: () => string | undefined;
  safety: WriteSafety;
}

interface FederatedResult {
  content?: Array<{ text?: string }>;
  isError?: boolean;
  structuredContent?: unknown;
}

/** Unwrap a federated MCP result → structuredContent, or parsed text, or raw text. */
function parseFederated(res: unknown): { ok: boolean; data: unknown; text: string } {
  const r = res as FederatedResult;
  const text = r?.content?.[0]?.text ?? '';
  if (r?.structuredContent !== undefined) return { ok: !r.isError, data: r.structuredContent, text };
  try {
    return { ok: !r?.isError, data: JSON.parse(text), text };
  } catch {
    return { ok: !r?.isError, data: text, text };
  }
}

export function createLifecycle(deps: LifecycleDeps) {
  const { driver, callTool, safety } = deps;
  const dest = (): string => {
    const d = deps.destination();
    if (!d) throw new Error('No ABAP destination is connected. Configure ARC1_SAP_* (see README).');
    return d;
  };

  /** Resolve {name, objectType} → repotree AFF URI (search → getLsUri). */
  async function resolveAffUri(ref: ObjectRef): Promise<string> {
    const d = dest();
    const { references } = await quickSearch(driver, {
      destination: d,
      pattern: ref.name,
      maxResults: 20,
      types: [ref.objectType],
    });
    const hit =
      references.find((r) => r.name?.toUpperCase() === ref.name.toUpperCase() && r.uri) ??
      references.find((r) => r.uri);
    if (!hit?.uri) {
      throw new Error(`Object ${ref.name} (${ref.objectType}) not found via search.`);
    }
    return getLsUri(driver, d, hit.uri);
  }

  return {
    resolveAffUri,

    async readSource(args: ObjectRef & { include?: string }): Promise<string> {
      let uri = await resolveAffUri(args);
      if (args.include) uri = includeAffUri(uri, args.include);
      const content = await readFile(driver, uri);
      if (isUnsupportedPlaceholder(content)) {
        throw new Error(
          `Object type ${args.objectType} is not served by adt-ls headless (classic ABAP). Use main ARC-1 for this type.`,
        );
      }
      return content;
    },

    async createObject(args: {
      objectType: string;
      name: string;
      packageName: string;
      description: string;
      /** CTS transport for non-$TMP packages; `''` (default) for local objects. */
      transportRequestNumber?: string;
    }): Promise<CreateResult> {
      assertWriteAllowed(safety, { action: 'create_object', packageName: args.packageName });
      const res = await callTool('abap_creation-create_object', {
        destination: dest(),
        objectType: args.objectType,
        // objectContent stays {name,packageName,description}; the transport is a
        // SEPARATE top-level arg (adt-ls marks it required — '' means local/$TMP).
        objectContent: JSON.stringify({
          name: args.name,
          packageName: args.packageName,
          description: args.description,
        }),
        transportRequestNumber: args.transportRequestNumber ?? '',
      });
      const { ok, data, text } = parseFederated(res);
      if (!ok) throw new Error(`create_object failed: ${text}`);
      const d = data as CreateResult;
      return { message: d.message, filePath: d.filePath };
    },

    async updateSource(args: ObjectRef & { source: string; include?: string }): Promise<void> {
      assertWriteAllowed(safety, { action: 'update_source' });
      let uri = await resolveAffUri(args);
      if (args.include) uri = includeAffUri(uri, args.include);
      await writeFile(driver, uri, args.source);
    },

    async activate(args: ObjectRef): Promise<ActivateResult> {
      assertWriteAllowed(safety, { action: 'activate_object' });
      const uri = await resolveAffUri(args);
      const res = await callTool('abap_activate_objects', { destination: dest(), uris: [uri] });
      const { data } = parseFederated(res);
      const d = (data ?? {}) as { success?: boolean; objectDiagnostics?: unknown[] };
      return { success: !!d.success, diagnostics: d.objectDiagnostics ?? [] };
    },

    async runUnitTests(args: ObjectRef): Promise<unknown> {
      const uri = await resolveAffUri(args);
      const res = await callTool('abap_run_unit_tests', { destination: dest(), uris: [uri] });
      return parseFederated(res).data;
    },

    async deleteObject(args: ObjectRef): Promise<void> {
      assertWriteAllowed(safety, { action: 'delete_object' });
      const uri = await resolveAffUri(args);
      await deleteFile(driver, metadataAffUri(uri));
    },

    /**
     * Run a RAP generator (e.g. OData UI service): scaffolds a full set of objects
     * (table/CDS/BDEF/SRVD/SRVB) into `packageName`. `content` is the JSON string
     * matching the generator's get_schema. Mutating (gated by writes + package).
     */
    async generateObjects(args: {
      generatorId: string;
      content: string;
      packageName: string;
      transportRequestNumber?: string;
      referencedObjectType?: string;
      referencedObjectName?: string;
    }): Promise<unknown> {
      assertWriteAllowed(safety, { action: 'generate_objects', packageName: args.packageName });
      const res = await callTool('abap_generators-generate_objects', {
        destination: dest(),
        generatorId: args.generatorId,
        content: args.content,
        packageName: args.packageName,
        transportRequestNumber: args.transportRequestNumber ?? '',
        referencedObjectType: args.referencedObjectType ?? '',
        referencedObjectName: args.referencedObjectName ?? '',
      });
      const { ok, data, text } = parseFederated(res);
      if (!ok) throw new Error(`generate_objects failed: ${text}`);
      return data;
    },

    /**
     * Validate an object's creation input before create (read-only). Returns the
     * validation verdict; a "would-be-invalid" result is data, not a thrown error.
     */
    async validateObject(args: {
      objectType: string;
      name: string;
      packageName: string;
      description: string;
    }): Promise<unknown> {
      const res = await callTool('abap_creation-run_validation', {
        destination: dest(),
        objectType: args.objectType,
        objectContent: JSON.stringify({
          name: args.name,
          packageName: args.packageName,
          description: args.description,
        }),
      });
      return parseFederated(res).data;
    },

    /**
     * Find the transport request(s) relevant to creating/changing ONE object
     * (read-only validation, object-scoped — not a system transport list).
     */
    async findTransport(args: {
      objectName: string;
      objectType: string;
      developmentPackage: string;
      isCreation: boolean;
    }): Promise<unknown> {
      const res = await callTool('abap_transport-get', {
        destination: dest(),
        objectName: args.objectName,
        objectType: args.objectType,
        developmentPackage: args.developmentPackage,
        isCreation: args.isCreation,
      });
      return parseFederated(res).data;
    },

    /** Create a CTS transport request (mutating — gated by transport-writes). */
    async createTransport(args: {
      developmentPackage: string;
      transportDescription: string;
      isCreation: boolean;
      objectName?: string;
      objectType?: string;
    }): Promise<unknown> {
      assertWriteAllowed(safety, {
        action: 'create_transport',
        packageName: args.developmentPackage,
        requireTransportWrites: true,
      });
      const res = await callTool('abap_transport-create', {
        destination: dest(),
        developmentPackage: args.developmentPackage,
        transportDescription: args.transportDescription,
        isCreation: args.isCreation,
        ...(args.objectName ? { objectName: args.objectName } : {}),
        ...(args.objectType ? { objectType: args.objectType } : {}),
      });
      const { ok, data, text } = parseFederated(res);
      if (!ok) throw new Error(`create_transport failed: ${text}`);
      return data;
    },

    // ── Native CTS transport + lock (adtLs/cts/transport + adtLs/fileSystem) ──
    // The robust, always-present LSP path (vs the dynamic, backend-provided
    // abap_transport-* IDE-action tools). See docs/research/adt-ls-capability-map.md §4c.

    /**
     * List MY modifiable CTS transport requests on the connected system. Uses the
     * native rich search (which defaults the owner to the logged-on user and the
     * status to modifiable) — a system-wide transport list, vs findTransport's
     * object-scoped lookup. Read-only.
     */
    listTransports(): Promise<unknown> {
      return driver.sendRequest('adtLs/cts/transport/searchTransports', { destinationId: dest() });
    },

    /** Read an object's lock status: `{lockingSupported, lockId}` (lockId null = not
     * locked). Read-only — useful for diagnostics and pre-write checks. */
    async getLockStatus(args: ObjectRef): Promise<unknown> {
      const uri = await resolveAffUri(args);
      return driver.sendRequest('adtLs/fileSystem/getFileLockStatus', { uri });
    },

    /**
     * Assign an existing CTS transport to an object — the native lock→transport step
     * that has NO federated (abap_transport-*) equivalent. Mutating; gated by
     * transport-writes (also requires allowWrites). `$TMP`/local objects need no
     * transport, so adt-ls rejects assigning one to them.
     */
    async assignTransport(args: ObjectRef & { transport: string }): Promise<unknown> {
      assertWriteAllowed(safety, { action: 'assign_transport', requireTransportWrites: true });
      const objectUri = await resolveAffUri(args);
      return driver.sendRequest('adtLs/cts/transport/assignTransportToObject', {
        objectUri,
        transport: args.transport,
      });
    },
  };
}

export type Lifecycle = ReturnType<typeof createLifecycle>;
