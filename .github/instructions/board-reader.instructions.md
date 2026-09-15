---
applyTo: "packages/board-reader/**"
---

# `@openlogo/board-reader` working rules

This package is the reusable, headless bridge from photographs of the OpenLogo magnetic board kit
to editable OpenLogo source. It owns provider-neutral recognition contracts, deterministic layout
and source generation, confidence/issues, and validation through the public parser API.

- Do not import browser globals, DOM types, Studio modules, runtime internals, or model credentials.
- Accept portable raster data and structural cancellation signals so browser, worker, and Node
  consumers can provide their own adapters.
- Keep recognition perception behind `BoardRecognitionProvider`; multimodal LLM clients, model
  runtimes, and OCR engines are replaceable implementations, not part of the source-generation
  contract.
- Treat LLM output as untrusted input: validate the structured response against the magnet catalog,
  bounds, confidence range, and image dimensions before source generation.
- Never place API keys, HTTP endpoints, or vendor SDKs in this package. Consumers inject the LLM
  client and own network/privacy policy.
- Return recognition issues separately from normative parser/checker diagnostics.
- Never generate an AST directly. Generate canonical OpenLogo source and validate it with
  `@openlogo/parser`.
- Keep ordering, nesting, tie-breaking, and source generation deterministic and fully tested.
- Do not add language syntax or edit `spec/`; board import is tooling outside the language profiles.
- Do not bundle a trained model until a consented evaluation corpus, licensing review, and browser
  performance benchmark exist.
