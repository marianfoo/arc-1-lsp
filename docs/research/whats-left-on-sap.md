# What's left on SAP — the full adt-ls capability landscape

> **⚠️ SUPERSEDED IN PART (2026-06-02).** This doc reverse-engineered the *minified
> extension front-end*. The authoritative, **decompiled-server** inventory is now
> [`adt-ls-capability-map.md`](adt-ls-capability-map.md) — read that first. It overturns
> three verdicts here: **hover is NOT blocked on SAP** (it's a fixable client bug — we
> never prime the token cache via `semanticTokens`; see capability-map §3a); **formatting**
> is disabled-at-init but dynamically registered per-URI on `didOpen` (§3b); **ATC** is
> backend-config-gated, not a headless limit (§3c). The "14 MCP tools" figure below is
> also wrong: the embedded server has **7 static tools + a dynamic, backend-driven set**
> (IDE-Actions → `abap_*`; capability-map §5). The strategic shape (custom `adtLs/*` is
> the untapped seam) holds.

**Question:** beyond arc-1-lsp's 27 tools, what *else* does SAP's `adt-ls` expose,
what's reachable but unwired, and what's genuinely blocked on SAP? This is a
code-grounded inventory, not a guess.

**Method (2026-06-01):** (1) grepped the installed extension front-end
(`sapse.adt-vscode 1.0.0` → `dist/_bundle/extension.js`, 502 KB) for every LSP /
custom method string it calls — the authoritative namespace; (2) dumped the
adt-ls server's `initialize` **capabilities** (what it advertises); (3) **live-
probed** the interesting methods against a4h (S/4HANA 2023, adt-ls
`1.0.0.202605281240`). Every verdict below cites code presence and/or a live result.

> **TL;DR.** The embedded MCP tools (14) and the *advertised* standard-LSP code-
> intelligence are fully tapped. The big untapped seam is the **custom `adtLs/*`
> namespace (~80 methods)** — coverage, business-service publish/preview/Fiori-gen,
> richer transport, run-application, AI code-prediction, debugger, richer ABAP
> Unit, LSP-side object creation. Genuinely blocked-on-SAP: `hover` (null headless),
> ATC (reachable but needs check-variants configured on the backend), and the
> standard-LSP "extras" the server doesn't implement headless.

---

## 1. adt-ls exposes three surfaces (arc-1-lsp drives all three)

1. **Standard LSP** `textDocument/*` — the server advertises a subset (below).
2. **Custom `adtLs/*`** — ~80 private JSON-RPC methods (the real ADT surface).
3. **Embedded MCP server** — 14 tools (all wired; see `adt-ls-reference.md` §2).

---

## 2. Standard LSP (`textDocument/*`) — advertised = the real boundary

The extension's generic LSP client *references* ~40 `textDocument/*` methods, but
the adt-ls **server only implements those it advertises** in `initialize`
capabilities. Live-probing the non-advertised ones returns **"Internal error"** —
so the advertised set is the true boundary.

| Method | Advertised? | arc-1-lsp | Live result |
|---|---|---|---|
| `documentSymbol` | ✅ | **wired** `document_symbols` | rich tree |
| `definition` / `declaration` | ✅ | **wired** `go_to_definition` | LocationLink[] |
| `references` | ✅ | **wired** `find_references` | Location[] (timeout-guarded) |
| `prepareTypeHierarchy` (+`typeHierarchy/{super,sub}types`) | ✅ | **wired** `type_hierarchy` | full tree |
| `diagnostic` | ✅ | **wired** `check_syntax` | `{kind:full,items}` |
| `completion` | ✅ | **wired** `completion` | CompletionList |
| `documentHighlight` / `codeLens` / `semanticTokens` | ✅ | skipped | low LLM value (`[]`/raw) |
| `hover` | ✅ (advertised) | skipped | returns `null` headless — **but fixable on OUR side** (token-cache gate; prime `semanticTokens/full` first → capability-map §3a). NOT a SAP block. |
| `implementation`, `rename`/`prepareRename`, `codeAction`, `prepareCallHierarchy`+`callHierarchy/*`, `workspace/symbol`, `foldingRange`, `signatureHelp`, `inlayHint`, `selectionRange` | ❌ **not advertised** | — | extension references them, but the server returns **"Internal error" headless** → not available |
| `formatting` / `rangeFormatting` / `onTypeFormatting` | ❌ (`false`) | — | `formatting` → `[]` (no-op); no pretty-print |

**Takeaway:** the wired 6 are the complete *useful* standard-LSP set. `hover` and
the "extras" (implementation/rename/code-action/call-hierarchy/workspace-symbol)
are **blocked on SAP** — the headless server doesn't serve them, even though the
desktop extension's client knows the method names.

---

## 3. Custom `adtLs/*` namespace — the big untapped seam (~80 methods)

These are **not** in LSP capabilities (custom requests). The ones arc-1-lsp uses
today (`destinations/*`, `fileSystem/*`, `repository/{getLsUri,quickSearch,getUsers}`,
`activation/*`, `mcp/*`) are a fraction. Full inventory from the extension, grouped,
with status:

### 3a. Wired today
`destinations/{initializeService,create,ensureLoggedOn,getLogonInfo,requestBrowserBasedLogon,list,…}`,
`fileSystem/{readFile,writeFile,delete,lockFile,unlockFile,getFileLockStatus}`,
`repository/{getLsUri,quickSearch,getUsers}`, `activation/{activate,getInactiveObjects}`,
`mcp/{startMCPServer,stopMCPServer,setDestination}`.

### 3b. Reachable but UNWIRED — the opportunity (verified / high-confidence)
| Area | Methods | Value | Evidence |
|---|---|---|---|
| **Code coverage** | `coverage/getCoverage`, `coverage/loadStatementResults` | High — line/branch coverage for ABAP Unit | **LIVE: works** → `{"coverage":[],"loadStatementRequest":{…}}` (empty without a coverage run) |
| **Richer ABAP Unit** | `abapUnit/{runTests,capabilities,validateRunParams}` | Med-High — capabilities + param validation + coverage hookup (vs the bare MCP `abap_run_unit_tests`) | method present; MCP unit-test already proven |
| **Business-service actions** | `businessservice/srvb/{getServiceBindingDetails,getPreviewURL,publishandUnpublishAction,getServiceEntitySet,getCreateFioriApp}` | **High** — publish/unpublish a binding, get OData preview URL, scaffold a Fiori app (we only have read-only `get_service_binding`) | methods present; SRVB type is served |
| **Richer transport / SolMan** | `cts/transport/{searchTransports,searchTransportsSimple,assignTransportToObject,createTransportForObjectLock,checkTransportForObjectLock}`, `cts/solman/{check,getConfiguration,requestObjectAllowlistApproval}` | Med — assign-to-object, search, ChaRM/SolMan approval (richer than MCP create/get) | methods present |
| **Run application** | `run/runApplication` | Med — execute a report/app | method present |
| **AI code prediction** | `codePrediction/{getCodePredictions,reportCodePredictionInsertion}` | Med — SAP's ML completion (distinct from LSP `completion`) | method present |
| **LSP-side object creation** | `objectCreation/{getCreatableObjectTypes,create,validate,getCreationUiModelAndContent,sideEffects}` | Med — a second creation path with UI model + side-effects + validate (parallel to the MCP creation tools) | methods present |
| **Model-driven UI** | `modelDriven/{schema,content,input,valueHelp,sideEffect,viewDescription,modelDrivenDescriptor}` | Low-Med — guided/value-help-driven creation | methods present |
| **Debugger** | `debugger/{initializeDebugger,breakpointsChanged,onBreakpointChangedRequest}` | High but **complex** — ABAP debugging (breakpoints, stepping) | methods present; large effort, stateful |
| **Version toggle / FS extras** | `fileSystem/{toggleVersion,readDirectory,getExternalLinks,abapStat,getObjectName,getPackageName,getFolderUri}` | Low-Med — active/inactive toggle, list class includes, object/package resolution | methods present |
| **Support bundle** | `support/{createSupportFile,getSupportFileOptions}` | Low — diagnostics export | methods present |
| **Joule** | `joule/getJouleDestination` | Low — SAP Joule (AI) destination | method present |

### 3c. Reachable but backend-config-dependent
| Area | Methods | Status |
|---|---|---|
| **ATC** (clean-core checks) | `atc/getCheckVariants`, `atc/runCheck` | **Reachable, but blocked by backend config.** `getCheckVariants {objectUri:<repotree URI>}` works → but a4h returns `{"checkVariants":{}}` (**no ATC check variants configured** on this trial system). `runCheck {objectUri}` then "Internal error" (no variant to run). On a system **with** ATC variants set up, the flow `getCheckVariants → runCheck` should work. (Key: the object key is `objectUri` = the **repotree** AFF URI, NOT the ADT path.) |

---

## 4. What's genuinely "left on SAP" (we can't unblock from our side)

1. ~~**`hover`**~~ — **CORRECTED: not a SAP block.** The decompiled server shows the
   headless null is the `AbapDocumentTokenCache` gate (`AbapTokenFilterService.shouldCallBackend`),
   primed only by `textDocument/semanticTokens/full`. We never send it → cache empty →
   null. Fix on our side (capability-map §3a). Same for `documentHighlight`.
2. **Standard-LSP "extras"** — `implementation`, `rename`, `codeAction` (quick
   fixes), `callHierarchy` (who-calls-whom), `workspace/symbol`, `foldingRange`,
   `signatureHelp` — the headless server returns "Internal error". The desktop
   extension uses them, so SAP *could* enable them headless. → **ask SAP** which are
   on the roadmap for headless adt-ls.
3. **ATC headless behaviour** — reachable, but is the empty `getCheckVariants` an
   a4h-config gap or a headless limitation? → **verify on an ATC-configured system;
   confirm with SAP.**
4. **Formatting / pretty-print, revision history** — not served (`formatting`→`[]`;
   no pretty-print/revision methods). → main ARC-1's domain unless SAP adds them.
5. **`adt_lsp_*` MCP tools** — SAP's own LSP-proxy prototype (Thomas Ritter) is **not
   in 1.0.0** (`adt_lsp` = 0 hits in the extension). **If SAP ships `adt_lsp_*` in
   adt-ls's MCP, federate theirs and retire our `navigation.ts`** (assumptions §5).

---

## 5. What we could still BUILD (reachable, unblocked) — prioritized

1. **Business-service actions** (`businessservice/srvb/*`) — publish/unpublish a
   binding + OData preview URL + Fiori-app scaffold. Completes the RAP→OData→Fiori
   story; today we only *read* bindings. **High.**
2. **Code coverage** (`coverage/getCoverage`) — pair with `run_unit_tests` to report
   covered/uncovered lines. Live-verified reachable. **High, small.**
3. **Richer transport** (`cts/transport/{assignTransportToObject,searchTransports}`)
   — assign objects to TRs + search, beyond create/find. **Med.**
4. **ATC** (`atc/getCheckVariants → runCheck`) — wire it now (objectUri = repotree);
   it'll light up on any backend with check variants configured. **High (gated on a
   real system).**
5. **Run application** (`run/runApplication`), **richer ABAP Unit**
   (`abapUnit/{capabilities,validateRunParams}`), **AI code-prediction**
   (`codePrediction/*`), **object-creation-via-LSP** (`objectCreation/*`). **Med.**
6. **Debugger** (`debugger/*`) — powerful but a large, stateful build. **Later.**

These are pure adt-ls (ADR-0003) — no new SAP protocol, same connection.

---

## 6. Questions for SAP (Thomas Ritter)

1. Will `adt_lsp_*` (your LSP-proxy MCP tools) ship in adt-ls's MCP? If so we'd
   federate them instead of maintaining our `navigation.ts`.
2. `hover` returns `null` headless across all positions — what's the correct
   invocation (resolve step? newer build)?
3. Which standard-LSP methods (`implementation`/`rename`/`codeAction`/`callHierarchy`/
   `workspace/symbol`) are intended to work **headless**? They "Internal error" today.
4. ATC headless: is `getCheckVariants` returning `{}` purely an a4h-config gap, or a
   headless limitation? What's the supported `runCheck` flow?
5. Any pretty-print / format / revision-history method we missed?

---

## Appendix — full `adtLs/*` method inventory (from extension.js)

```
abapUnit/{capabilities,runTests,validateRunParams}
activation/{activate,getInactiveObjects}
atc/{getCheckVariants,runCheck}
businessservice/srvb/{getCreateFioriApp,getPreviewURL,getServiceBindingDetails,getServiceEntitySet,publishandUnpublishAction}
codePrediction/{getCodePredictions,reportCodePredictionInsertion}
coverage/{getCoverage,loadStatementResults}
cts/solman/{check,getConfiguration,requestObjectAllowlistApproval}
cts/transport/{assignTransportToObject,checkTransportForObjectLock,createTransportForObjectLock,searchTransports,searchTransportsSimple}
debugger/{breakpointsChanged,initializeDebugger,onBreakpointChangedRequest}
destinations/{create,createProject,deleteProject,ensureLoggedOn,getLogonInfo,getStorePath,initializeService,list,listSystemConfigurations,logonStateChanged,requestBrowserBasedLogon,requestLogonInput,settingsChanged,stopLogonAttempt}
fileSystem/{abapStat,delete,fileLockStatusChanged,forceRefresh,getExternalLinks,getFileLockStatus,getFolderUri,getObjectName,getPackageName,lockFile,readDirectory,readFile,stat,toggleVersion,unlockFile,writeFile}
joule/getJouleDestination
mcp/{setDestination,startMCPServer,stopMCPServer}
modelDriven/{content,input,modelDrivenDescriptor,schema,sideEffect,valueHelp,viewDescription}
objectCreation/{create,getCreatableObjectTypes,getCreationUiModelAndContent,sideEffects,validate}
repository/{getLsUri,getUsers,quickSearch}
run/runApplication
support/{createSupportFile,getSupportFileOptions}
textDocument/{insertProposal,notifyDirtyState}
```
(adt-ls `1.0.0.202605281240`; re-extract per release — the startup version warning flags drift.)
