import {
  defineConfig,
  loadEnv,
  type Plugin,
  type PreviewServer,
  type ViteDevServer,
} from "vite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { modelErrorMessage } from "./src/board-recognition-response.js";

const executeFile = promisify(execFile);

function boardRecognitionProxy(env: Record<string, string>): Plugin {
  const installMiddleware = (server: ViteDevServer | PreviewServer): void => {
    server.middlewares.use(
      "/api/recognize-board",
      async (request, response) => {
        if (request.method !== "POST") {
          response.statusCode = 405;
          response.end("Method not allowed");
          return;
        }

        const endpoint = env.OPENLOGO_LLM_ENDPOINT;
        if (!endpoint) {
          response.statusCode = 503;
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({ error: "LLM endpoint is not configured." }),
          );
          return;
        }

        const cancellation = new AbortController();
        response.once("close", () => {
          if (!response.writableEnded) cancellation.abort();
        });
        try {
          const requestBody = await readJsonBody(request);
          const accessToken = await getAzureAccessToken(env);
          const modelResponse = await fetch(endpoint, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify(createVisionRequest(requestBody, env)),
            signal: cancellation.signal,
          });
          const responseText = await modelResponse.text();
          if (!modelResponse.ok) {
            response.statusCode = modelResponse.status;
            response.setHeader("content-type", "application/json");
            response.end(
              JSON.stringify({
                error: modelErrorMessage(responseText, modelResponse.status),
              }),
            );
            return;
          }
          response.statusCode = 200;
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify(extractModelJson(JSON.parse(responseText))),
          );
        } catch (error) {
          if (cancellation.signal.aborted || response.destroyed) return;
          response.statusCode = 502;
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({
              error:
                error instanceof Error ? error.message : "LLM request failed.",
            }),
          );
        }
      },
    );
  };
  return {
    name: "openlogo-board-recognition-proxy",
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}

async function getAzureAccessToken(
  env: Record<string, string>,
): Promise<string> {
  const scope = validatedAzureCliArgument(
    env.OPENLOGO_LLM_SCOPE ?? "https://ai.azure.com/.default",
    "OPENLOGO_LLM_SCOPE",
  );
  const args = [
    "account",
    "get-access-token",
    "--scope",
    scope,
    "--query",
    "accessToken",
    "-o",
    "tsv",
  ];
  if (env.OPENLOGO_AZURE_TENANT_ID) {
    args.push(
      "--tenant",
      validatedAzureCliArgument(
        env.OPENLOGO_AZURE_TENANT_ID,
        "OPENLOGO_AZURE_TENANT_ID",
      ),
    );
  }
  try {
    const executable =
      process.platform === "win32" ? process.env.ComSpec : "az";
    if (!executable)
      throw new Error("Windows command interpreter was not found.");
    const executableArgs =
      process.platform === "win32"
        ? ["/d", "/s", "/c", "az.cmd", ...args]
        : args;
    const { stdout } = await executeFile(executable, executableArgs);
    const token = stdout.trim();
    if (!token) {
      throw new Error("Azure CLI returned an empty access token.");
    }
    return token;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Azure CLI failed.";
    throw new Error(
      `Could not acquire an Entra ID token. Run 'az login'. ${detail}`,
    );
  }
}

function validatedAzureCliArgument(value: string, name: string): string {
  if (!/^[a-zA-Z0-9./:_-]+$/.test(value)) {
    throw new Error(`${name} contains unsupported characters.`);
  }
  return value;
}

function readJsonBody(
  request: import("node:http").IncomingMessage,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    request.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > 12_000_000) {
        reject(new Error("Board image request is too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const value: unknown = JSON.parse(
          Buffer.concat(chunks).toString("utf8"),
        );
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          reject(new Error("Board request must be a JSON object."));
          return;
        }
        resolve(value as Record<string, unknown>);
      } catch {
        reject(new Error("Board request is not valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function createVisionRequest(
  body: Record<string, unknown>,
  env: Record<string, string>,
) {
  const imageBase64 = String(body.imageBase64 ?? "");
  const imageMimeType = String(body.imageMimeType ?? "image/png");
  const imageWidth = String(body.imageWidth ?? "unknown");
  const imageHeight = String(body.imageHeight ?? "unknown");
  const instructions = String(body.instructions ?? "");
  const magnetCatalog = JSON.stringify(body.magnetCatalog ?? []);
  return {
    model: env.OPENLOGO_LLM_MODEL || undefined,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `${instructions} Return exactly {"blocks":[...]} with each block containing name, arguments, bounds, confidence, and children. Bounds must use this image coordinate space: width ${imageWidth}, height ${imageHeight}. The supported magnet catalog is: ${magnetCatalog}`,
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Recognize this OpenLogo magnetic board." },
          {
            type: "image_url",
            image_url: {
              url: `data:${imageMimeType};base64,${imageBase64}`,
              detail: "high",
            },
          },
        ],
      },
    ],
  };
}

function extractModelJson(response: unknown): unknown {
  const content = (
    response as { choices?: Array<{ message?: { content?: unknown } }> }
  ).choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error("LLM response did not contain message content.");
  }
  const withoutFence = content.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  return JSON.parse(withoutFence);
}

/**
 * The Vite config for `@openlogo/studio`'s browser host (#277 — see
 * `docs/adr/0011-studio-app-bundler.md`). This only bundles the DOM-facing `index.html`/`web/`
 * entry; the library itself still builds via `tsc -b` (`npm run build`), unaffected by Vite.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "OPENLOGO_");
  return {
    root: ".",
    publicDir: "web/public",
    plugins: [boardRecognitionProxy(env)],
    build: {
      outDir: "web-dist",
    },
  };
});
