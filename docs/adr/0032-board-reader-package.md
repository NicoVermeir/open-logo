# 32. Reusable board-reader package

- Status: Proposed
- Date: 2026-09-10
- Related: ADR-0006, ADR-0018

## Context

OpenLogo Studio should be able to import a photograph of the magnetic instruction board and place
editable OpenLogo source in the editor. Image recognition is perception and tooling, not language
semantics, and must remain reusable by other hosts such as a lesson authoring tool or a native
application.

The current magnet artwork has no machine-readable markers. Recognition therefore needs a
kit-specific provider that can evolve independently from deterministic layout reconstruction and
source generation. Browser APIs, model runtimes, OCR engines, network credentials, and UI state
must not leak into the reusable contract.

## Decision

Add a private workspace package named `@openlogo/board-reader`. It accepts portable RGBA raster
data and an injected `BoardRecognitionProvider`. The package owns the structured recognized-block
model, confidence/issues, deterministic ordering and nesting, canonical OpenLogo source generation,
and validation through the public `@openlogo/parser` API.

Recognition issues are separate from language diagnostics. The package returns parser/checker
findings as `languageDiagnostics`, while provider and confidence findings are returned as package
issues. The package never generates an AST directly and never changes the language specification.

Studio owns only file selection, browser image decoding, status presentation, and importing the
result through its existing editor controller. Import never executes the generated program. The
default application build may omit a provider; in that case the UI reports that recognition is not
configured. A local model provider may be added later after an accuracy, licensing, bundle-size,
privacy, and low-end-device benchmark. Optional cloud providers must be injected by consumers and
must not carry credentials or vendor types in this package.

## Consequences

- Board recognition is reusable and headless, with deterministic tests for all non-perception logic.
- Studio stays an app-shell consumer rather than becoming an image-processing package.
- The first implementation can ship the stable contract and test seam before a trained model is
  ready.
- A model evaluation corpus and provider implementation are still required for real photograph
  recognition; the package does not pretend that color/shape heuristics are production accuracy.
- Adding the package expands the workspace from six to seven packages and requires its own scoped
  working agreement.
