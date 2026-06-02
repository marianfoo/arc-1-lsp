# adt-ls capability map — the complete decompiled surface

**The definitive, code-grounded inventory of everything SAP's `adt-ls` exposes**, with
a per-capability usefulness triage for arc-1-lsp and an honest wiring-gap. This
supersedes the reverse-engineered guesses in [`whats-left-on-sap.md`](whats-left-on-sap.md)
(which read the *minified extension front-end*); here we read the **actual server**.

> **Method (2026-06-02).** The adt-ls server ships as a full Eclipse RCP app under
> `…/sapse.adt-vscode-1.0.0-darwin-arm64/adt-ls/…/Adt-ls.app/Contents/Eclipse/plugins/`.
> Its language-server logic is `com.sap.adt.ls_1.0.0.202605281240.jar` (736 classes)
> and the embedded MCP server is `com.sap.adt.mcp.core_3.58.1.jar` (34 classes). Both
> were **decompiled with CFR 0.152**, run on the bundled SapMachine JRE 21:
> ```
> JRE=…/com.sap.adt.jvm.sapmachineminimal.macosx.aarch64_21.11.0/jre/bin/java
> "$JRE" -jar cfr.jar com.sap.adt.ls_*.jar       --outputdir src-ls
> "$JRE" -jar cfr.jar com.sap.adt.mcp.core_*.jar --outputdir src-mcp
> ```
> Every method below is read from the LSP4J `@JsonSegment`/`@JsonRequest` interfaces
> and DTO classes; every verdict cites a class/field name. Re-run per adt-ls release.

---

## 1. Three surfaces — precise counts

| Surface | What | Boundary | Count |
|---|---|---|---|
| **Standard LSP** `textDocument/*` | go-to, references, hover, completion, symbols, type-hierarchy, diagnostics, … | the **advertised `ServerCapabilities`** (`AdtLanguageServer.doInitialize`) — anything not advertised "Internal error"s headless | 11 providers advertised |
| **Custom `adtLs/*`** JSON-RPC | the real ADT surface (transport, activation, ATC, coverage, creation, srvb, run, debugger, …) | **23 `@JsonSegment` interfaces**, **84 `@JsonRequest` + 8 `@JsonNotification`** = ~92 methods | 23 segments / ~92 methods |
| **Embedded MCP server** (`/mcp`) | a Streamable-HTTP MCP endpoint adt-ls hosts on localhost | **7 static tools** + a **dynamic, backend-driven** set (IDE-Actions → `abap_*`) | 7 static + N dynamic |

arc-1-lsp drives all three. The big finding (unchanged from the prior doc, now exact):
the **custom `adtLs/*` namespace is the deep untapped seam** — but two important
corrections to prior verdicts (hover, formatting) and one architectural insight (the
MCP tool list is *dynamic*) emerge only from the decompiled source.

---

## 2. Standard-LSP boundary — the advertised `ServerCapabilities`

From `AdtLanguageServer.doInitialize()` — this is the **authoritative** headless boundary
(the server only serves what it advertises here):

| Provider | Advertised | arc-1-lsp | Notes (from source) |
|---|---|---|---|
| `documentSymbol` | ✅ `DocumentSymbolOptions` | **wired** | ABAP only; **client-side parse** (`AdtClientStructuralInfoService`), no backend round-trip; class split into Definition/Implementation sections |
| `definition` (→ ABAP *implementation*) | ✅ | **wired** | `AdtTextDocumentService.definition → FilterValue.IMPLEMENTATION`. On multiple targets, piggybacks a **subtypes** type-hierarchy job (= "all redefinitions") |
| `declaration` (→ ABAP *definition*) | ✅ | unwired | `declaration → FilterValue.DEFINITION` (the LSP↔ABAP inversion). ≈ definition for ABAP |
| `references` | ✅ `AdtLsReferences.getOptions()` | **wired** | RIS where-used backend; **heaviest call** (ForkJoinPool(4) snippet scan) → must timeout-guard |
| `typeHierarchy` | ✅ | **wired** | CLAS/INTF; lazy super/sub expansion from `item.data`; 10 s backend timeout |
| `diagnostic` | ✅ `DiagnosticRegistrationOptions(false,false)` | **wired** `check_syntax` | **pull model**, per-document only. The two `false`s = `interFileDependencies=false`, `workspaceDiagnostics=false` → **no `workspace/diagnostic`** (can't "lint a whole package" in one call). Runs ADT syntax/semantic checkrun on the dirty buffer; adds TABL-status + BDEF-impl checks; **NOT ATC** |
| `completion` (+resolve) | ✅ `resolveProvider=true`, `completionItem` | **wired** (resolve unwired) | **No trigger characters** (invoke-only). `completionItem/resolve` enriches docs via the same backend as hover, **and sidesteps the token-cache gate** → cheap, high-signal |
| `hover` | ✅ `IAdtLsHoverService.getHoverOptions()` | unwired | **ADVERTISED.** ABAP/DDLS/JSON renderers exist. The null we saw is **not** a SAP gap — see §3 |
| `documentHighlight` | ✅ `DocumentHighlightOptions` | unwired | ABAP occurrences (read/write/text). **Same token-cache gate as hover** (§3) |
| `codeLens` | ✅ `IAdtLsCodeLensService.getOptions()` | unwired | Only **SRVB** (publish/preview/Fiori lenses) + **AFF-JSON** (model-driven action lenses). No ABAP-source or unit-test lens. Lens commands are mostly **client-side VS Code commands** |
| `semanticTokens` (full) | ✅ 23 token types / 10 modifiers | unwired | ABAP/CDS/BDEF/SRVD/DCL/DDLA/json/generic. **Its ABAP run is what primes the hover/highlight token cache** (§3) |
| `executeCommand` | ⚠️ **only if `isAdtVsCodeExtension()`** | n/a | Gated on the client sending `initializationOptions.userAgentInfos:[{name:"ADTVSCode"}]`. Even unlocked, the only server commands are `adt-ls-server.{runModelDrivenAction,getModelDrivenActionInput}` (AFF model-driven editor) — small payoff |
| `formatting` / `rangeFormatting` | ❌ `setDocument(Range)FormattingProvider(false)` | n/a | **Disabled at init** — but see §3 (per-type `*FormatService` classes exist + **dynamic per-URI registration on `didOpen`**) |
| `implementation`, `rename`, `codeAction`, `callHierarchy`, `workspace/symbol`, `signatureHelp`, `foldingRange`, `inlayHint`, `selectionRange` | ❌ not advertised | — | The extension's generic client references the method names, but the headless server **"Internal error"s** them. Genuinely not served. |

**Per-type dispatch (`SourceBasedFeatureFactory.initializeMaps`)** — a standard feature
only works for an object type if a `(feature→impl)` entry exists for it:

| Feature | ABAP | DDLS | DCL | SRVD | BDEF | DDLA | json | generic |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| navigation (def/decl/refs) | ✅ | ✅ | ✅ | ✅ | ✅ | – | ✅ | ✅ |
| hover | ✅ | ✅ | – | – | – | – | ✅ | – |
| completion | ✅ | ✅ | ✅ | ✅ | ✅ | – | ✅ | ✅ |
| semanticTokens | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| documentSymbol / documentHighlight / typeHierarchy | ✅ | – | – | – | – | – | – | – |
| codeLens | – | – | – | (SRVB✱) | – | – | ✅ | – |

✱ SRVB codeLens is special-cased in `AdtTextDocumentService.codeLens` before the factory.

---

## 3. CORRECTIONS to prior verdicts (the decompile overturns three)

### 3a. `hover` (and `documentHighlight`) — NOT blocked on SAP; a fixable client bug

Prior docs said *"hover returns null at every position headless — blocked on SAP, ask
Thomas."* **The decompiled root cause says otherwise.**

`AbapLsHoverService.getHover()` short-circuits to `null` at
`tokenFilter.shouldCallBackend(param, position)` **before any backend call**.
`AbapTokenFilterService.shouldCallBackend` reads the token under the cursor from
`AbapDocumentTokenCache.getTokenAtOffset(uri, offset, documentVersion)` and returns true
only for `CAT_IDENTIFIER`/`CAT_LITERAL`. `getTokenAtOffset` returns `null` when the URI
isn't cached **or the cached document version ≠ current**. And the cache is populated
**only as a side-effect of `textDocument/semanticTokens/full`** (`AbapSemanticTokensProvider.parse()`
→ `updateTokenCache()`). `didOpen`/`didChange` do **not** fill it.

> **arc-1-lsp never sends `semanticTokens` → the ABAP token cache is always empty →
> `shouldCallBackend` is always false → ABAP hover is unconditionally null.** This
> exactly reproduces what we observed. **`documentHighlight` uses the identical gate.**

**Fix (our side, no SAP dependency):** for each ABAP hover/highlight, first issue
`textDocument/semanticTokens/full` for the same URI at the **same (unchanged) document
version**, then call hover/highlight. (DDLS and JSON hover parse inline — no priming
needed; they already work.) `completionItem/resolve` reaches the *same* element-info
backend renderer **without** the gate, so it's an even cheaper way to surface ABAP
signatures/ABAP-Doc. **Hover content is rich** when reached: `LsMethodMarkdownRenderer`
emits a full signature (importing/exporting/changing/returning/raising + ABAP-Doc short
text); `LsClassInterfaceMarkdownRenderer` / `LsTypeMarkdownRenderer` for types.

### 3b. `formatting` — disabled at init, but dynamically registered per-URI

`doInitialize` sets `documentFormattingProvider=false`, **yet** the per-type services
(`AbapLsFormatService`, `DdlsLsFormatService`, `SrvdLsFormatService`, …) exist and
`AbstractAdtFormatService.setDynamicRegistrationForFormattingForLsUri` registers a
**dynamic** formatting capability per ABAP document on `didOpen` (and range-formatting on
`initialized`). So a client that supports `client/registerCapability` (dynamic
registration) and opens the doc first could get **ABAP Pretty-Printer** formatting. A
headless client that ignores dynamic registration (today's arc-1-lsp) sees the static
`false` → no-op. → **a real follow-up probe**, not a flat "not served."

### 3c. `ATC` — reachable; gated by backend config, not a headless limit

Prior verdict: *"`atc/runCheck` Internal-errors for every variant — not functional
headless."* The decompile (`AtcCheckService`) shows: with an **empty `checkVariant`**,
`runCheck` uses `getSystemDefaultCheckVariant()` from the backend customizing. The empty
`getCheckVariants` on a4h means **the trial backend has no ATC variants configured** — a
system-config gap, not a code limit. The earlier "Internal error" came from passing
**non-existent variant names**. On an ATC-configured backend, `runCheck({objectUri:"" → system default})`
should work. Caveat: it **busy-polls every 1 s with no internal cap** → wrap in our own timeout.

---

## 4. Custom `adtLs/*` — complete inventory by domain

Legend — **Usefulness** for an LLM-driven ABAP agent: **High** = clear value + reachable
headless · **Med** = useful in context · **Low** = niche · **Skip** = UI-only / interactive / license-gated.

### 4a. Authoring — object creation & generation
Segments `adtLs/objectCreation` (5), `serverExtension/objectGenerator` (6).

| Method | Params (key) | Result (key) | Intent | Use | Wired |
|---|---|---|---|---|:--:|
| `objectCreation/getCreatableObjectTypes` | `destination` | `[{name,objectType}]` | live, auth-filtered creatable-type catalog (14 types) | Med | no |
| `objectCreation/getCreationUiModelAndContent` | `name,description,objectType,destination` | `{fieldGroupSections[],objectContent}` | the per-type **form schema** (fields, bindingPaths, required, value-help) + empty content skeleton | High | no |
| `objectCreation/sideEffects` | `…,fieldGroup,path,determination,featureControl` | `{fieldGroupSections,objectContent}` | reactive form logic (recompute dropdowns / derive names) | Skip (LLM supplies all fields) | no |
| `objectCreation/validate` | `destination,objectType,objectContent,fieldGroup` | `{status(LsStatus),objectContent,fieldGroupSections}` | server-side pre-create gate (package exists, name legal, type-specific) + tells you if a transport is required | High | no |
| `objectCreation/create` | `destination,objectType,objectContent,transportRequestNumber` | `{status,uri,templateContent}` | **creates the object**: transport-checks, content-type-negotiates, builds EMF model, `createFileRemote`; returns starter source for CDS/DCL/aspect/type | High | no |
| `objectGenerator/fetchAllGenerators` | `projectDestination,referencedObjectUri` | `IFeed` of use-cases | catalog of generators available **for a given reference object** (table/CDS/package) | Med-High | no |
| `objectGenerator/getSchemaForObjectGeneration` | `useCase,packageName,referenceObject,…` | `{schemaJson,configurationJson,contentJson}` | the server-defined input form for a chosen generator | High | no |
| `objectGenerator/getListOfObjectsToBeGenerated` | `useCase,schema` | `IGroup` of `IObject{ref,CREATE}` | **dry-run preview** of exactly what would be generated | High | no |
| `objectGenerator/generateObjects` | `uri,useCase,referenceObject,schema,transportRequestNumber` | `{generatedObject[],transportValidation[]}` | **mass-creates** the whole RAP object set in one transport-checked call | High | no |
| `objectGenerator/validateCategoriesPage` / `validatePackageAndReferenceObject` | wizard pages | `IValidationMessages` | interactive-wizard / pre-flight validation | Low / Med | no |

**Creatable types (14, from `creation/ObjectType` + the 14 `creation/adapter/*`):** ABAP
Class `CLAS/OC`, Interface `INTF/OI`, Access Control `DCLS/DL`, CDS Aspect `DRAS/RAS`,
Behavior Definition `BDEF/BDO` (name derived from `rootEntity`), CDS Type `DRTY/STY`,
Change Document `CHDO/CHD`, Data Definition `DDLS/DF` (fetches element list from backend),
Metadata Extension `DDLX/EX`, Number Range `NROB/NRO`, SAP Object Node Type `NONT/NOT`,
SAP Object Type `RONT/ROT`, Service Binding `SRVB/SVB`, Service Definition `SRVD/SRV`.
**Not creatable here:** FUGR/FUNC, PROG, classic DDIC (DOMA/DTEL/TABL/structures), MSAG,
DDLA (schema bundled but no adapter) — deliberately RAP/clean-core-flavored.

> **`create` ≫ `writeFile`** (which arc-1-lsp uses today): it validates transport
> recording, negotiates the right ADT content-type (handles oo.classes v2/v3/v4),
> builds the proper EMF model, and returns generated starter source. Recommendation:
> use the 4-step `objectCreation` pipeline as the canonical "create new object" path;
> keep `writeFile` for *updates* to existing source.

### 4b. Quality & test
Segments `adtLs/abapUnit` (3), `adtLs/coverage` (2), `adtLs/atc` (2).

| Method | Params (key) | Result (key) | Intent | Use | Wired |
|---|---|---|---|---|:--:|
| `abapUnit/runTests` | `lsUris[]`, `durations[]`, `riskLevels[]`, `scope[]`(OWN/FOREIGN), `measurement("COVERAGE")`, `outputFormatParams` | `{result(tree of AbapUnitResultItem), status, coverageParams, output}` | run ABAP Unit; **structured tree** = program→class→method, each with pass/fail predicates, `alerts[]` (kind/severity/`details`/`stackEntries` w/ navigable positions), `executionTime` | High | no |
| `abapUnit/capabilities` | `lsUri` | `{abapUnitSupport,ownTestSupport,advancedRunSupport,previewSupport}` | feature probe per object | Med | no |
| `abapUnit/validateRunParams` | `AbapUnitRunParams` | `{messages[](code INACTIVE/DIRTY/OTHER, severity)}` | dry-run: dirty/inactive/multi-project guards | Med | no |
| `coverage/getCoverage` | `destinationId,coverageMeasurementUri,forObjects[]` | `{coverage[](CoverageNode tree: statement/procedure/branch {covered,total}), loadStatementRequest}` | aggregate coverage % per object — **requires a prior `runTests(measurement="COVERAGE")`** to mint the URI | Med-High | no |
| `coverage/loadStatementResults` | `loadStatementResultsUri,statementUris[]` | `{procedures[],statements[],branches[]}` (executed flags + ranges) | lazy per-line/branch coverage | Low-Med | no |
| `atc/runCheck` | `objectUri(lsUri),checkVariant("" ⇒ system default)` | `{atcRunCheckResults[]}` of `AtcRunFinding{lineNumber,priority,location,message,checkId,checkTitle,checkClass,messageId}` | run ATC static analysis; busy-polls until finished | High (on ATC-configured backend) | no |
| `atc/getCheckVariants` | `quickPickUserInput,objectUri` | `{checkVariants: Map<name,desc>}` | list configured variants (often skippable — runCheck falls back to system default) | Med | no |

> ATC is **additive, not redundant** to `check_syntax`: `textDocument/diagnostic` is the
> ADT syntax/semantic checkrun (+TABL/BDEF specials), with **no ATC merge**. `AtcRunFinding`
> exposes **no quickfix/exemption** data → report-only.

### 4c. Lifecycle & transport
Segments `adtLs/cts/transport` (5), `adtLs/cts/solman` (3), `adtLs/activation` (2),
`adtLs/destinations` (10), `adtLs/fileSystem` lock subset.

| Method | Params (key) | Result (key) | Intent | Use | Wired |
|---|---|---|---|---|:--:|
| `cts/transport/checkTransportForObjectLock` | `operationType(CREATE/MOD/DEL)`, `objectInfo(Either<ObjectUri,ObjectDetails>)`, `transportLayer`, `isRecordChanges` | `{isTransportCheckSuccessful,isRecordingRequired,isLockedInRequests,transports[],locks[],transportCreationConfiguration{supportsCtsProject,supportsChangeDocument}, checkMessages}` | **the decision oracle**: does this object/package need a transport, which are assignable, is it already locked | High | no |
| `cts/transport/createTransportForObjectLock` | `description,ctsProject,changeGuid,checkData` | `ITransportRequest` | create a TR sized to the object's package/layer (honors Solman change-doc) | High | no |
| `cts/transport/assignTransportToObject` | `objectUri,transport` | `Boolean` | pin an existing TR to a locked object | High — **no MCP/federation equivalent** | no |
| `cts/transport/searchTransportsSimple` | `destinationId,owner(req),function` | `List<ITransportRequest>` | owner-scoped "my open transports" | Med | no |
| `cts/transport/searchTransports` | `number,owner,function[],status[],from/toDate` | `List<ITransportRequest>` | rich search — **but most filters are dead** in this build (forces MODIFIABLE, owner=self, number-prefix only) | Med | no |
| `cts/solman/getConfiguration` | `destinationId` | `{isSolmanIntegrationEnabled,changeDocumentAssignmentConfiguration,isObjectAllowlistApprovalEnabled}` | is ChaRM active / change-doc required | Med (Solman systems only) | no |
| `cts/solman/check` | `objectUri,transport,operationType` | `{status,changeDocument,issues[],conflicts[]}` | ChaRM check-run (CSOL/CRTO/WHLO/CUST) | Low-Med | no |
| `cts/solman/requestObjectAllowlistApproval` | `allowlistIssues[],operation,transport` | `Boolean` | submit WHLO allowlist for approval | Skip | no |
| `activation/activate` | `{destination,lsUris[],references[],forceActivation}` | `{isCheckExecuted,isActivationExecuted,isGenerationExecuted,isForceSupported,refreshLsUris[],objectDiagnostics[]}` | **the real activation primitive** — batch, ref- or uri-based, `forceActivation`, full per-object diagnostics | High | via MCP wrapper |
| `activation/getInactiveObjects` | `{destination}` | `[AdtObjectReference]` | the "what's dirty" worklist | High | **yes** |
| `destinations/{initializeService,list,listSystemConfigurations,create,createProject,deleteProject,getLogonInfo,ensureLoggedOn,stopLogonAttempt,getStorePath}` | `LsDestinationData{id,protocol(rfc/http),properties}` | various | destination store + Eclipse-project lifecycle + logon | High (5 wired) | partial |
| `fileSystem/getFileLockStatus` | `{uri}` | `{lockingSupported,lockId}` | read the lock handle (null = unlocked) | Med-High | no |
| `fileSystem/toggleVersion` | `{uri}` | `Void` | flip ACTIVE↔INACTIVE for inactive-draft awareness | Med | no |
| `fileSystem/{lockFile,unlockFile,stat,abapStat,readDirectory,forceRefresh,getObjectName,getPackageName,getFolderUri,getExternalLinks}` | `{uri}` | various | lock/introspect/utility (`getExternalLinks` = "open in GUI") | Low-Med | lock subset |

> **Transport flow is a 3-step state machine** (check → assign | create → lock+write),
> NOT "lock returns corrNr". `LockFileResponse` does **not** carry a transport — the
> lock handle is fetched via `getFileLockStatus().lockId`, and transport selection is an
> explicit `checkTransportForObjectLock` → `assignTransportToObject` round-trip.
>
> **`ITransportRequest` caveat:** the LS-model converter only populates
> `number/description/owner/target.name/ctsProject.name` — treat
> `status/function/lastChangedOn/tasks` as unreliable from these endpoints.

### 4d. Code intelligence (custom) & search
Segments `adtLs/repository` (3), `adtLs/codePrediction` (2), `adtLs/textDocument` (2),
`adtLs/joule` (1).

| Method | Params (key) | Result (key) | Intent | Use | Wired |
|---|---|---|---|---|:--:|
| `repository/quickSearch` | `{destination,pattern,maxResults,types[]}` | `{references[AdtObjectReference{name,description,uri,type}],message}` | full RIS object search (facet syntax: `#owner:`, package/release-state) | High | **yes** |
| `repository/getLsUri` | `{destination,adtUri}` | `{uri}` | ADT URI → LS repotree URI (the key enabler) | High | **yes** |
| `repository/getUsers` | `{destination}` | `{[{id,text}]}` | user value-help | Med | **yes** |
| `codePrediction/getCodePredictions` | `{documentItem,position}` | `[{prediction,predictionId,inlineCompletionText}]` | **AI inline ghost-text** (no range/score); gated by config `adt.joule.editor.predictiveCodeCompletion` + an AIA backend endpoint; self-disables on quota/errors | High *iff* Joule/AIA enabled | no |
| `codePrediction/reportCodePredictionInsertion` | `{completion,documentItem,position}` | `[Void]` | acceptance telemetry | Low | no |
| `textDocument/insertProposal` | `{uri,position,proposalId}` | `{string,start,end}` | materialize a parked completion proposal (session-scoped `identityHashCode` id) into snippet text | Med (completion-flow only) | no |
| `textDocument/notifyDirtyState` | `{uri,dirty}` (notification) | — | client buffer dirty/clean bookkeeping | Low | no |
| `joule/getJouleDestination` | `fileUri` | `String` | the side-by-side Joule AI destination for the project | Skip | no |

### 4e. Advanced / runtime / UI
Segments `adtLs/businessservice/srvb` (5), `adtLs/run` (1), `adtLs/debugger` (2 + 4 client
notifications), `adtLs/modelDriven` (8), `adtLs/support` (2), `adtLs/mcp` (3).

| Method | Params (key) | Result (key) | Intent | Use | Wired |
|---|---|---|---|---|:--:|
| `businessservice/srvb/publishandUnpublishAction` | `ServiceBindingRequestParams{lsUri,…}` | `{isExecuted,isPublishSuccess,statusMessage}` | **publish/unpublish a binding** — makes the OData service live (V4 toggles on `isPublished()`, V2 on live URL) | **High** | no |
| `businessservice/srvb/getServiceBindingDetails` | `{lsUri,…}` | `{serviceBindingName,services[],odataversion,objectData}` | read binding metadata | Med | reads via MCP |
| `businessservice/srvb/getServiceEntitySet` | `ServiceBindingPreviewData` | `[{entityName,isLeading,applicationState}]` | list bound entities | Med | no |
| `businessservice/srvb/getPreviewURL` | `ServiceBindingPreviewData` | `String` (OData `/sap/opu/odata…` URL) | live service-preview URL for an entity | Med | no |
| `businessservice/srvb/getCreateFioriApp` | `ServiceBindingPreviewData` | `String` (`vscode://…fiorigenerator?…` deep link) | **UI-only** — actual gen happens in the VS Code App Modeler | Skip | no |
| `run/runApplication` | `lsUri` (class/program) | `String` (**console output**) | ADT "Run As → ABAP Application (Console)" — run a `if_oo_adt_classrun` class or report and capture `out->write` | **High** | no |
| `debugger/initializeDebugger` / `onBreakpointChangedRequest` | control-channel | — | thin control channel; the real session is a **full DAP bridge** over a separate loopback socket (`AdtLsDebugAdapter implements IDebugProtocolServer`), **attach-only, event-driven, stateful** | **Skip** (interactive) | no |
| `modelDriven/{content,schema,viewDescription,modelDrivenDescriptor,valueHelp,sideEffect,action,actionInput}` | `{modelId,arguments}` | JSON form descriptors | generic **server-driven-UI** form protocol (backs the AFF JSON editor + creation wizard). Its useful subset is already wrapped by `abap_creation-*` | **Skip** (direct) | no |
| `support/{getSupportFileOptions,createSupportFile}` | data-collector ids | diagnostic ZIP path | SAP-support bundle | Skip | no |
| `mcp/{startMCPServer,setDestination,stopMCPServer}` | `{port,token}` → `{port,token}` | — | start/stop the embedded MCP server + bind a destination | High (federation entry) | **yes** |

> **SRVB `publishandUnpublishAction` + `run/runApplication` are the two clean,
> high-value, currently-unwired wins** in this cluster — both need an `lsUri` resolvable
> in the LS workspace (the same coupling the creation tools accept). Publishing closes
> the RAP→OData→callable loop; run lets an agent smoke-test generated ABAP and read output.

---

## 5. The embedded MCP server — architecture & DYNAMIC tool collection

`com.sap.adt.mcp.core` hosts adt-ls's own MCP endpoint. arc-1-lsp already starts it
(`adtLs/mcp/startMCPServer`) and federates to it. The decompile reveals it's **partly
dynamic**, which matters for how we treat the federated tool list.

- **Transport:** official `io.modelcontextprotocol` Java SDK,
  `HttpServletStreamableServerTransportProvider`, **Streamable HTTP at `/mcp`**,
  serverInfo `("ADT MCP Server","1.0.0")`, 30 s request timeout. Jetty bound to
  **localhost only**.
- **Auth:** `TokenAuthenticationFilter` requires `Authorization: Bearer <token>`. The
  token is **auto-generated** (`SecureRandom`, 16 bytes, Base64url) unless the LSP client
  supplies one, and **returned over LSP** in `AdtMcpServerInitializationInfo{port,token}`.
  `DNSRebindingProtectionFilter` allows only `Host: localhost|127.0.0.1`. → arc-1-lsp must
  propagate the returned `{port,token}` into the federated MCP client's bearer header.
- **Tool collection = static + dynamic** (`AdtMCPToolsRegistry.collectAllTools(destinationId)`):
  - **7 static** (Eclipse extension point `com.sap.adt.mcp.core.adtMcpTools`):
    `abap_activate_objects`, `abap_run_unit_tests`,
    `abap_creation-get_all_creatable_objects`, `abap_creation-get_object_type_details`,
    `abap_creation-run_validation`, `abap_creation-create_object`, and the
    destinations-list tool (`AdtDestinationsMcpTool`).
  - **N dynamic** (`AdtMCPToolsIdeActionCollector`, only when a destination is set):
    fetches the connected backend's **IDE-Actions (AIA)**, keeps those whose title starts
    with `MCP`, and exposes each as an MCP tool with **backend-authored** schema/description.
    Naming transform: lowercase, then `mcp_`→`abap_`, `mcp-`→`abap_`, `mcp`→`abap`. The
    registry **swaps** the dynamic set on every `setDestination`.

> **This is why `abap_transport-get`/`abap_transport-create` are NOT in `plugin.xml`** —
> they're **backend IDE-Action tools** (`MCP_TRANSPORT-*`), present only when the connected
> system ships them, and version-/system-dependent. arc-1-lsp's `find_transport`/
> `create_transport` ride on these. **The robust alternative is the native
> `adtLs/cts/transport/*` JSON-RPC** (always compiled in, typed) — and `assignTransportToObject`
> has *no* federated equivalent at all. **Treat the federated tool list as dynamic and
> re-enumerate on `setDestination`.**

---

## 6. Wiring gap & prioritized build list

arc-1-lsp wires the **destinations / fileSystem / repository / activation(via MCP) / mcp**
segments + standard `textDocument/{definition,references,documentSymbol,completion,diagnostic}`
+ `typeHierarchy`. Everything in §4a/4b and most of 4c/4e is unwired. Prioritized by
value × effort × headless-reachability:

1. **Fix ABAP hover + documentHighlight** (§3a) — prime `semanticTokens` at the same doc
   version, then call. Pure client-side; unlocks two advertised features we wrongly wrote
   off. *Tiny effort, immediate value.*
2. **`completionItem/resolve`** — enrich existing completion with signatures/ABAP-Doc;
   sidesteps the token-cache gate. *Tiny.*
3. **`repository/quickSearch` is already wired** ✅ — but confirm facet/`types[]` exposure.
4. **ATC** `atc/runCheck({objectUri, checkVariant:""})` — lean on the system default
   variant; surface `AtcRunFinding` as lint. *Med; gated on an ATC-configured backend +
   our own poll timeout.* Biggest static-analysis capability gap.
5. **ABAP Unit (native `abapUnit/runTests`)** over the structured tree (not the text-blob
   MCP tool) + **coverage** (`runTests(measurement="COVERAGE")` → `getCoverage`). *Med.*
6. **SRVB `publishandUnpublishAction`** (+ `getPreviewURL`, `getServiceEntitySet`) — close
   RAP→OData. **`run/runApplication`** — smoke-test generated ABAP, read console output. *Med.*
7. **Native transport** (`adtLs/cts/transport/*`, esp. `assignTransportToObject`) +
   **native `activation/activate`** (`forceActivation`, ref-based, no 15-object cap) —
   replace the lossy/federation-dependent paths. *Med.*
8. **`objectCreation` 4-step pipeline** as the canonical create path (richer than
   `writeFile`); **`objectGenerator`** for one-shot RAP scaffolding with a dry-run preview.
   *Larger; high payoff.*
9. **`fileSystem/toggleVersion` + `getFileLockStatus`** — inactive-draft awareness + lock
   diagnostics. *Small.*

**Skip:** debugger (interactive DAP), modelDriven (UI protocol — covered by `abap_creation-*`),
`getCreateFioriApp` (vscode: deep link), joule/support, sideEffects/wizard-validation.

---

## 7. Backend feature landscape & reachability (the other ~80 plugins)

The `Adt-ls.app` Eclipse RCP bundles **~80 `com.sap.adt.*_3.58.x` feature plugins** behind
the one LS plugin. Decompiling the reachability-relevant ones confirms an architectural
invariant and surfaces what SAP *has* but doesn't expose headless.

**Architectural invariant (verified):** `grep '@JsonSegment|@JsonRequest'` across
`ideactions`, `refactoring(.model)`, `objectgenerator`, `atc.core`, `tools.classrun`
returns **nothing**. Only `com.sap.adt.ls` declares JSON-RPC. **The `adtLs/*` + standard-LSP
surface (§2, §4) is therefore the complete callable boundary** — every other plugin is an
in-process backend the LS delegates to. arc-1-lsp cannot reach them except through an LS method.

**The type boundary is a front-end choice, not a backend gap.** The backend ships full
classic support — `ddic.{domain,dataelement,table,structure,tabletype,view,enqu,typegroup}`,
`programs`, `functions`, `oo`, `messageclass`, `enho.model`/`enhs`, `textelements`,
`setgetparameters`, `packages` — yet the LS `objectCreation`/`readFile` only serve the
modern clean-core/RAP set (§4a). So the §4 "object-type boundary" is the LS front-end
deliberately not wiring these backends, **not** an absence of capability. SAP *could*
expose classic types headless later (watch-item).

**IDE-Actions / AIA (`com.sap.adt.ideactions`) — the dynamic-MCP-tool engine.** Model:
`IAction{getId,getTitle,getSummary,hasConfigurationStep,getUserInputConfiguration}`;
`IActionManager` exposes a real **`performHeadless(...)`** path (→ `List<IActionResultContent>{uri,content}`)
plus `getActionConfiguration` (the input schema) and `getAction`. `AiaBackendUtil.getEnabledActions(project,resources,monitor)`
fetches the system's enabled actions over ADT REST (URI via `AiaUriDiscovery`, content
types in `IContentTypes`). The MCP layer (`AdtMCPToolsIdeActionCollector`, §5) keeps those
whose title starts with `MCP` and renames to `abap_*`. **The catalog is 100% backend-defined**
— statically un-enumerable; it's whatever `MCP_*` AIA actions the connected S/4 ships. There
is also AI-provenance plumbing here: `GenAICodeLogger.markAiGeneratedCode(...)` /
`sourceCodePasted(...)` tag AI-written ABAP on the backend — relevant if arc-1-lsp wants to
mark agent-generated code as such.

**Refactoring (`com.sap.adt.refactoring` + `.model`) — present, NOT reachable headless.**
ADT defines exactly four refactorings, each with a backend handler:
`BackendRenameRefactoringHandler` (**Rename**), `BackendExtractMethodRefactoringHandler`
(**Extract Method**, `ExtractMethodInfo`), **Extract CLIF** (extract class/interface —
`ExtractClif*`, `ExtractInterfaceInfo`), and `ChangePackageRefactoringHandler` (**Change
Package**). But they ride the Eclipse **LTK** UI framework (`AdtCompositeChange`,
`AdtTextChange`, `AdtRefactoringDescriptor`) — there is **no `@JsonSegment("adtLs/refactoring")`**
and the LSP `rename`/`codeAction` providers are **unadvertised** (§2). **So none of ADT's
refactorings is reachable from a headless client today.** Exposing Rename/Extract would
need SAP to advertise LSP `rename`/`codeAction` or add an `adtLs/refactoring` segment — a
concrete, high-value ask (added to §9).

**Run (`com.sap.adt.tools.classrun`) — confirms `adtLs/run/runApplication`.** Two discovery
relations gate it: `http://www.sap.com/adt/relations/oo/classrun` (term `classrun`, for
classes implementing `if_oo_adt_classrun`) and `…/programs/programrun` (term `programrun`,
for executable programs). The object must expose the relation (else "not supported"); output
is captured console text. Matches §4e.

---

## 8. What's genuinely blocked on SAP (much shorter now)

1. **Standard-LSP "extras"** — `implementation`, `rename`, `codeAction`, `callHierarchy`,
   `workspace/symbol`, `signatureHelp` — **not advertised** → "Internal error" headless.
   The desktop extension's client references them, so SAP *could* enable them headless.
2. **`workspace/diagnostic`** — disabled (`DiagnosticRegistrationOptions(false,false)`) →
   no project-wide pull; you must iterate files to "lint a package."
3. **Formatting** — *probably* unblockable on our side via dynamic registration (§3b);
   needs a probe before we call it a SAP gap.
4. **Revision history** — no method.
5. **`adt_lsp_*` federation** — SAP's own LSP-proxy MCP tools (Thomas Ritter) are **not in
   1.0.0**. If they ship, federate theirs and retire our `navigation.ts`.

(Removed from this list vs. the prior doc: **hover** — it's our bug (§3a); **ATC** — it's
backend config (§3c).)

---

## 9. Questions for SAP (Thomas Ritter) — refreshed

1. **Hover/highlight**: we found the headless null is the `AbapDocumentTokenCache` gate
   (`AbapTokenFilterService.shouldCallBackend`) — primed only by `semanticTokens/full`. Is
   priming semanticTokens the intended sequence for a headless client, or is there a
   cleaner contract? (We can work around it; confirming the intended flow would help.)
2. **Standard-LSP extras**: which of `implementation`/`rename`/`codeAction`/`callHierarchy`/
   `workspace/symbol` are planned to work **headless**? They're unadvertised today.
3. **`workspace/diagnostic`**: any plan to enable project-wide pull diagnostics?
4. **Formatting**: it's `false` at init but dynamically registered per-URI on `didOpen` —
   is ABAP Pretty-Printer formatting expected to work for a dynamic-registration-aware
   headless client?
5. **ATC**: confirm the `runCheck({checkVariant:""}) → system-default-variant` flow, and
   that `getCheckVariants` empties purely reflect backend config.
6. **`adt_lsp_*`**: will your LSP-proxy MCP tools ship in adt-ls's MCP? We'd federate them.
7. **MCP IDE-Action tools** (`AdtMCPToolsIdeActionCollector`): is the `MCP`-prefixed
   IDE-Action → `abap_*` tool mechanism a stable contract we can rely on, and what's the
   canonical list of `MCP_*` actions on S/4 Cloud?
8. **Refactoring**: the backend has Rename / Extract Method / Extract CLIF / Change Package
   (`com.sap.adt.refactoring`), but none is reachable headless (no `adtLs/refactoring`
   segment; `rename`/`codeAction` unadvertised). Any plan to expose them — via LSP
   `rename`/`codeAction` or a custom segment? **Rename especially is high-value for an agent.**
9. **Classic object types**: the backend ships full DDIC/programs/functions/enhancement
   plugins, but the LS only serves the clean-core/RAP set. Will the headless LS expose
   classic-type read/create, or is that a permanent clean-core boundary?

---

## Appendix A — full segment / method list (decompiled)

```
adtLs/abapUnit            runTests, capabilities, validateRunParams
adtLs/activation          activate, getInactiveObjects
adtLs/atc                 runCheck, getCheckVariants
adtLs/businessservice/srvb getServiceBindingDetails, publishandUnpublishAction, getServiceEntitySet, getPreviewURL, getCreateFioriApp
adtLs/codePrediction      getCodePredictions, reportCodePredictionInsertion
adtLs/coverage            getCoverage, loadStatementResults
adtLs/cts/solman          getConfiguration, check, requestObjectAllowlistApproval
adtLs/cts/transport       checkTransportForObjectLock, createTransportForObjectLock, assignTransportToObject, searchTransportsSimple, searchTransports
adtLs/debugger            initializeDebugger, onBreakpointChangedRequest  (+ client: abap/debugger/{launch,syncBreakpoints,breakpointsEmpty,activationConflict}Notification)
adtLs/destinations        initializeService, listSystemConfigurations, list, create, createProject, deleteProject, getLogonInfo, ensureLoggedOn, stopLogonAttempt, getStorePath  (+ client: logonStateChanged, settingsChanged, requestLogonInput, requestBrowserBasedLogon)
adtLs/fileSystem          stat, abapStat, readDirectory, readFile, writeFile, delete, toggleVersion, getObjectName, getPackageName, lockFile, unlockFile, getFileLockStatus, forceRefresh, getFolderUri, getExternalLinks  (+ client: fileLockStatusChanged)
adtLs/joule               getJouleDestination
adtLs/mcp                 startMCPServer, setDestination, stopMCPServer
adtLs/modelDriven         content, schema, viewDescription, modelDrivenDescriptor, valueHelp, sideEffect, action, actionInput  (+ client: input)
adtLs/objectCreation      getCreatableObjectTypes, getCreationUiModelAndContent, sideEffects, validate, create
adtLs/repository          getUsers, getLsUri, quickSearch
adtLs/run                 runApplication
adtLs/support             getSupportFileOptions, createSupportFile
adtLs/textDocument        insertProposal, notifyDirtyState
serverExtension           initialize, initialized, shutdown, setTrace, exit, cancelProgress
serverExtension/objectGenerator  fetchAllGenerators, validateCategoriesPage, validatePackageAndReferenceObject, getSchemaForObjectGeneration, getListOfObjectsToBeGenerated, generateObjects
```
Standard LSP (advertised): documentSymbol, definition, declaration, references,
typeHierarchy(prepare/super/sub), diagnostic, completion(+resolve), hover,
documentHighlight, codeLens, semanticTokens(full); executeCommand (VS-Code-gated).

## Appendix B — key implementation classes (for re-verification)

- Boundary: `internal/server/AdtLanguageServer.doInitialize` (capabilities), `isAdtVsCodeExtension` (`CLIENT_ADT_VS_CODE="ADTVSCode"`).
- Hover gate: `internal/hover/AbapLsHoverService`, `internal/parser/AbapTokenFilterService.shouldCallBackend`, `AbapDocumentTokenCache.getTokenAtOffset`, `internal/parser/AbapSemanticTokensProvider.updateTokenCache`.
- Dispatch: `internal/textdocument/AdtTextDocumentService`, `…/SourceBasedFeatureFactory.initializeMaps`.
- Creation: `internal/creation/{ObjectType,CreationAdapterFactoryRegistry,AdtLsCreationUtil}`, `creation/adapter/*`, `creation/mcp/*`.
- Generator: `internal/objectgenerator/{ObjectGeneratorCoreService,ObjectGeneratorUIProviderRemote}`, `dto/{params,results}`.
- Test/quality: `internal/abapunit/{model,model/output}`, `internal/coverage/model`, `internal/atc/{AtcCheckService,AtcCheckVariantService}`, `internal/diagnostic/AdtLsDiagnosticService`.
- Transport: `internal/transport/internal/{TransportCheckService,TransportCreationService,TransportAssignmentService,TransportSearchService}`, `transport/internal/solman/SolutionManagerService`, `transport/model/transport/Transport`.
- SRVB/run: `internal/servicebinding/*`, `internal/applicationrun/*`.
- MCP core: `src-mcp/com/sap/adt/mcp/core/server/ADTMCPServer`, `…/internal/util/{AdtMCPToolsRegistry,AdtMCPToolsExtensionCollector,AdtMCPToolsIdeActionCollector,ToolRegistrationService}`.
- Backend plugins (§7, decompiled separately, *not* JSON-RPC endpoints): `com.sap.adt.ideactions` (`IAction`, `IActionManager.performHeadless`, `AiaBackendUtil.getEnabledActions`, `GenAICodeLogger`), `com.sap.adt.refactoring(.model)` (`Backend{Rename,ExtractMethod}RefactoringHandler`, `ExtractClif*`, `ChangePackageRefactoringHandler`), `com.sap.adt.tools.classrun` (`AbapApplicationConsoleRunService`, classrun/programrun discovery relations). The remaining ~75 `com.sap.adt.*_3.58.x` plugins are the in-process ADT backends (DDIC, CDS, programs, functions, oo, atc, abapunit, transport, ris, …) — full classic support exists but is unexposed by the LS front-end.

(adt-ls `1.0.0.202605281240`; ADT feature plugins `3.58.x`. Re-extract per release — the
startup version warning in `src/version.ts` flags drift.)
