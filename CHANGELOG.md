# Changelog

## [0.1.0](https://github.com/marianfoo/arc-1-lsp/compare/arc-1-lsp-v0.0.1...arc-1-lsp-v0.1.0) (2026-06-01)


### Features

* ABAP authoring loop (read/create/update/activate/test/delete) behind write-safety ([44c72d2](https://github.com/marianfoo/arc-1-lsp/commit/44c72d217b841b98ea30485f581c23650f67f820))
* **adt-ls:** headless reentrance logon — engine connects to a4h (proven) ([aa75f8e](https://github.com/marianfoo/arc-1-lsp/commit/aa75f8e395b37f44f27b6ad539b57d2bbceef2e0))
* **authz:** scope model + API-key profiles + xs-security descriptor (enterprise-auth stage 1) ([fc12d5c](https://github.com/marianfoo/arc-1-lsp/commit/fc12d5c59b74d881ed3a0b31916ab9f151db5719))
* connectivity bridge (Task 2) + arc-1-style tools task (Task 4.5) ([a5bd03a](https://github.com/marianfoo/arc-1-lsp/commit/a5bd03a7508afeb359c201398fad852bb3783a2d))
* containerize — http-streamable transport, API-key auth, Dockerfile ([870aba9](https://github.com/marianfoo/arc-1-lsp/commit/870aba975ff1029b853f5bb4da31f10d1707f83c))
* deploy to BTP CF — $PORT handling, manifest, live on us10 ([9571fd1](https://github.com/marianfoo/arc-1-lsp/commit/9571fd1a2d20340e5229f76237e674343ea2b6ce))
* **deploy:** arc-1-lsp connects to a4h from BTP CF (plan 04 Task 5, DIRECT mode) ([a7e9dfa](https://github.com/marianfoo/arc-1-lsp/commit/a7e9dfa9f56f20527fcf0734850d3e4848f2c73e))
* **engine:** CF connectivity path — reverse proxy → bridge → Cloud Connector (plan 04 Task 4) ([fc1ee7f](https://github.com/marianfoo/arc-1-lsp/commit/fc1ee7fc16c27fbf777d61400d77860a95aeb626))
* foundation — embedded adt-ls driver + minimal MCP server ([af98d24](https://github.com/marianfoo/arc-1-lsp/commit/af98d24b4c7bff364f75248590c64faf265aca4e))
* get_generator_schema forwards referencedObjectType/Name ([638f8ad](https://github.com/marianfoo/arc-1-lsp/commit/638f8adbeea1e9aa1d15c03e9be63e3adfbd00a0))
* **lsp:** code-intelligence tools — symbols, definition, references, type hierarchy, syntax check, completion ([180f3eb](https://github.com/marianfoo/arc-1-lsp/commit/180f3eb329e62e8c3fa12658f12d369d06216643))
* plan 04 (CC bridge) + port arc-1 BTP primitives ([4d80624](https://github.com/marianfoo/arc-1-lsp/commit/4d806244ce52cabe654f995b55e7e7938e861095))
* **tools:** get_service_binding + arc-1 feature-parity doc (why/why-not per capability) ([56a1f3f](https://github.com/marianfoo/arc-1-lsp/commit/56a1f3fe3e6e8edbf4a7e8fafac443d3d9308eaf))
* **tools:** list_users, list_generators, get_generator_schema, get_object_type_details ([dd7b633](https://github.com/marianfoo/arc-1-lsp/commit/dd7b6331c19e21b9dc3f4c5e759f5dae2e6a3b96))
* **tools:** search_objects + list_inactive_objects (LSP) + tool-surface research ([775a470](https://github.com/marianfoo/arc-1-lsp/commit/775a470792f90f58b63b2a8c1c0ea8309dce7e11))
* wire generate_objects + transport + validation tools (21 total) ([e168c79](https://github.com/marianfoo/arc-1-lsp/commit/e168c7960278347b9d1ae89d984e7c117de5e290))


### Bug Fixes

* **adt-ls:** pass initializationOptions.userAgentInfos (unblocks backend HTTP) ([ec9e1fe](https://github.com/marianfoo/arc-1-lsp/commit/ec9e1fe194c287563672d363d75c9ae01a8747cf))
* self-heal SAP session re-logon + get_generator_schema packageName ([20e6bca](https://github.com/marianfoo/arc-1-lsp/commit/20e6bcab48bc74cac44873df95a638cabfd3116b))
