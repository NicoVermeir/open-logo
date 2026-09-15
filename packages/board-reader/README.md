# `@openlogo/board-reader`

Reusable, headless pipeline for turning a photograph of an OpenLogo magnetic instruction board into editable OpenLogo source.

The package does not own browser file inputs, camera access, model credentials, or UI. Consumers provide a `BoardRecognitionProvider` that recognizes the fixed magnet kit. The package then performs deterministic layout-to-source assembly and validates the generated source through `@openlogo/parser`.

```ts
import {
  createLlmBoardRecognitionProvider,
  readBoard,
  type RasterImage,
} from "@openlogo/board-reader";

const provider = createLlmBoardRecognitionProvider(llmClient);
const result = await readBoard(image, provider, {
  minimumConfidence: 0.7,
});

if (result.languageDiagnostics.length === 0) {
  editor.setText(result.source);
}
```

`createLlmBoardRecognitionProvider()` sends a portable base64 RGBA image and a fixed magnet catalog
to an injected multimodal client. The client may call Azure OpenAI, OpenAI, or another vision model;
the package contains no credentials, HTTP client, or vendor SDK. The provider validates the model's
structured JSON response before it reaches source generation. Recognition warnings are returned as
`issues`; OpenLogo parser/checker findings are returned separately as `languageDiagnostics`.

The LLM must return block JSON, not executable source. `board-reader` validates block names,
arguments, confidence, bounds, nesting, and image dimensions, then deterministically generates
OpenLogo source and validates it with the parser. Studio imports the source but does not execute it.

