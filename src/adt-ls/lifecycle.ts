import { type WriteSafety, assertWriteAllowed } from '../server/safety.js';
/**
 * The ABAP object authoring lifecycle, pure adt-ls (ADR-0003): resolve an object
 * by name → repotree AFF URI, then read / create / update / activate / test /
 * delete. Mutations go through the write-safety layer. Only the modern ABAP-Cloud
 * object types adt-ls serves headless work; classic types surface a clear error.
 * See docs/adt-ls-reference.md.
 */
import { isTransientColdError, withColdRetry } from './cold-retry.js';
import type { LspRequester } from './driver.js';
import { parseFederated } from './federated.js';
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
  /**
   * Heal a dead SAP session: probe liveness, re-logon if dead, resolve `true` iff it
   * re-logged on (so the caller retries). Optional — when omitted (tests), the
   * empty/error simply surfaces. See `makeReviveIfDead`.
   */
  reviveIfDead?: () => Promise<boolean>;
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
    // cold:true smooths the cold repository index: the first search after a fresh
    // connection can return [] or throw "Internal error" while adt-ls warms up, which
    // would otherwise surface as a spurious "not found" on the very first by-name op
    // (hover/delete/…). See cold-retry.ts.
    const doSearch = () =>
      quickSearch(
        driver,
        { destination: d, pattern: ref.name, maxResults: 20, types: [ref.objectType] },
        { cold: true },
      );
    let { references } = await doSearch();
    // Empty after cold-retry can also mean the SAP session DIED (idle-expired) — adt-ls
    // returns [] rather than "logged off". Probe + re-logon, then search once more before
    // declaring "not found". A genuinely-absent object: the probe finds the session alive
    // → no re-logon → we fall through to the not-found error below. See makeReviveIfDead.
    if (references.length === 0 && deps.reviveIfDead && (await deps.reviveIfDead())) {
      ({ references } = await doSearch());
    }
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
      const data = parseFederated(res).data;
      // adt-ls returns a bare string ("No tests found") when there are no tests.
      // Wrap it so the result is always a JSON object — consistent with
      // run_unit_tests_with_coverage and the rest of the toolset.
      return typeof data === 'string' ? { message: data } : data;
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
      // Local ($-prefixed) packages are non-transportable — yet the backend would still
      // create a useless workbench TR (verified live), and there's no release/delete tool
      // to undo it. Refuse early; find_transport already reports isRecordingRequired:false.
      if (args.developmentPackage.trim().startsWith('$')) {
        throw new Error(
          `Package "${args.developmentPackage}" is local (non-transportable) — no transport is needed, so create_transport is a no-op that would orphan an empty request. Use find_transport to confirm; only call create_transport for transportable packages.`,
        );
      }
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
     *
     * The raw search can return thousands of rows on a busy system — a token bomb
     * for an LLM context — so the result is normalized to an array, optionally
     * filtered (client-side substring across all fields), and capped to `limit`
     * (default 100). Returns `{total, matched, returned, truncated, transports}`.
     */
    async listTransports(opts: { limit?: number; query?: string } = {}): Promise<unknown> {
      // The CTS backend throws a transient "Internal error" both during the cold window
      // (verified live: a few failures then success on a fresh instance) AND when the SAP
      // session has DIED (idle-expired) — the latter never recovers by retry alone. So:
      // cold-retry first; if it still throws transient, revive (probe + re-logon) and retry.
      const fetchRaw = () =>
        withColdRetry(
          () => driver.sendRequest<unknown>('adtLs/cts/transport/searchTransports', { destinationId: dest() }),
          { attempts: 3, delayMs: 500, retryError: isTransientColdError },
        );
      let raw: unknown;
      try {
        raw = await fetchRaw();
      } catch (e) {
        if (!isTransientColdError(e) || !deps.reviveIfDead) throw e;
        await deps.reviveIfDead(); // re-logon if the session is dead (else a harmless probe)
        raw = await fetchRaw(); // one more pass — post-revive, or after the extra warm-up time
      }
      const list: unknown[] = Array.isArray(raw)
        ? raw
        : Array.isArray((raw as { transports?: unknown[] } | null)?.transports)
          ? (raw as { transports: unknown[] }).transports
          : Array.isArray((raw as { requests?: unknown[] } | null)?.requests)
            ? (raw as { requests: unknown[] }).requests
            : [];
      // Unrecognized non-array shape → return verbatim rather than silently hide data.
      if (list.length === 0 && !Array.isArray(raw)) return raw;
      const q = opts.query?.trim().toLowerCase();
      const matched = q ? list.filter((t) => JSON.stringify(t).toLowerCase().includes(q)) : list;
      const limit = opts.limit && opts.limit > 0 ? opts.limit : 100;
      const transports = matched.slice(0, limit);
      return {
        total: list.length,
        matched: matched.length,
        returned: transports.length,
        truncated: transports.length < matched.length,
        transports,
      };
    },

    /** Read an object's lock status. Always returns `{lockingSupported, lockId}` with
     * `lockId:null` when unlocked — adt-ls omits the key entirely in that case, so we
     * normalize it. Read-only — useful for diagnostics and pre-write checks. */
    async getLockStatus(args: ObjectRef): Promise<{ lockingSupported: boolean; lockId: string | null }> {
      const uri = await resolveAffUri(args);
      const r = (await driver.sendRequest('adtLs/fileSystem/getFileLockStatus', { uri })) as {
        lockingSupported?: boolean;
        lockId?: string | null;
      } | null;
      return { lockingSupported: r?.lockingSupported ?? false, lockId: r?.lockId ?? null };
    },

    /**
     * Assign an existing CTS transport to an object — the native lock→transport step
     * that has NO federated (abap_transport-*) equivalent. Mutating; gated by
     * transport-writes (also requires allowWrites). `$TMP`/local objects need no
     * transport, so adt-ls rejects assigning one to them.
     *
     * adt-ls returns a bare boolean (and reports `true` even for objects that need no
     * transport, e.g. $TMP). Wrap it in a structured, self-describing result so a
     * naked `true` isn't read as proof the assignment was meaningful.
     */
    async assignTransport(
      args: ObjectRef & { transport: string },
    ): Promise<{ assigned: boolean; object: string; objectType: string; transport: string }> {
      assertWriteAllowed(safety, { action: 'assign_transport', requireTransportWrites: true });
      const objectUri = await resolveAffUri(args);
      const raw = await driver.sendRequest('adtLs/cts/transport/assignTransportToObject', {
        objectUri,
        transport: args.transport,
      });
      const obj = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null;
      const assigned = raw === true || obj?.assigned === true || obj?.operationExecuted === true;
      return { assigned, object: args.name, objectType: args.objectType, transport: args.transport };
    },
  };
}

export type Lifecycle = ReturnType<typeof createLifecycle>;
