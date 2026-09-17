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
import {
  createAccessTokenCache,
  formatServerTiming,
} from "./vite-access-token-cache.mjs";
import { createVisionRequest } from "./vite-vision-request.mjs";

const executeFile = promisify(execFile);
const accessTokenCache = createAccessTokenCache();

function boardRecognitionProxy(env: Record<string, string>): Plugin {
  const installMiddleware = (server: ViteDevServer | PreviewServer): void => {
    server.middlewares.use(
      "/api/recognize-board",
      async (request, response) => {
        const requestStartedAt = performance.now();
        let authenticationDuration = 0;
        let modelDuration = 0;
        let parseDuration = 0;
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
        let modelRequestTimedOut = false;
        response.once("close", () => {
          if (!response.writableEnded) cancellation.abort();
        });
        try {
          const requestBody = await readJsonBody(request);
          const authenticationStartedAt = performance.now();
          const accessToken = await getAzureAccessToken(
            env,
            env.OPENLOGO_LLM_SCOPE ?? "https://ai.azure.com/.default",
          );
          authenticationDuration = performance.now() - authenticationStartedAt;
          const timeoutMilliseconds = modelTimeoutMilliseconds(env);
          const timeout = setTimeout(() => {
            modelRequestTimedOut = true;
            cancellation.abort();
          }, timeoutMilliseconds);
          const modelStartedAt = performance.now();
          let modelResponse: Response;
          let responseText: string;
          try {
            modelResponse = await fetch(endpoint, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                Authorization: `Bearer ${accessToken}`,
              },
              body: JSON.stringify(createVisionRequest(requestBody, env)),
              signal: cancellation.signal,
            });
            responseText = await modelResponse.text();
          } finally {
            clearTimeout(timeout);
            modelDuration = performance.now() - modelStartedAt;
          }
          if (!modelResponse.ok) {
            response.statusCode = modelResponse.status;
            response.setHeader("content-type", "application/json");
            setRecognitionTimingHeader(response, {
              auth: authenticationDuration,
              model: modelDuration,
              parse: parseDuration,
              total: performance.now() - requestStartedAt,
            });
            response.end(
              JSON.stringify({
                error: modelErrorMessage(responseText, modelResponse.status),
              }),
            );
            return;
          }
          const parseStartedAt = performance.now();
          const recognition = extractModelJson(JSON.parse(responseText));
          parseDuration = performance.now() - parseStartedAt;
          response.statusCode = 200;
          response.setHeader("content-type", "application/json");
          setRecognitionTimingHeader(response, {
            auth: authenticationDuration,
            model: modelDuration,
            parse: parseDuration,
            total: performance.now() - requestStartedAt,
          });
          response.end(JSON.stringify(recognition));
        } catch (error) {
          if (
            (cancellation.signal.aborted && !modelRequestTimedOut) ||
            response.destroyed
          )
            return;
          response.statusCode = 502;
          response.setHeader("content-type", "application/json");
          setRecognitionTimingHeader(response, {
            auth: authenticationDuration,
            model: modelDuration,
            parse: parseDuration,
            total: performance.now() - requestStartedAt,
          });
          response.end(
            JSON.stringify({
              error: modelRequestTimedOut
                ? `Board recognition timed out after ${modelTimeoutMilliseconds(env)} ms.`
                : error instanceof Error
                  ? error.message
                  : "LLM request failed.",
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
  scope: string,
): Promise<string> {
  const tenant = env.OPENLOGO_AZURE_TENANT_ID ?? "";
  return accessTokenCache.get(`${tenant}|${scope}`, () =>
    acquireAzureAccessToken(env, scope),
  );
}

async function acquireAzureAccessToken(
  env: Record<string, string>,
  scope: string,
): Promise<string> {
  const args = [
    "account",
    "get-access-token",
    "--scope",
    validatedAzureCliArgument(scope, "Azure token scope"),
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

function modelTimeoutMilliseconds(env: Record<string, string>): number {
  const configured = Number(env.OPENLOGO_LLM_TIMEOUT_MS ?? 20_000);
  return Number.isFinite(configured) && configured > 0 ? configured : 20_000;
}

function setRecognitionTimingHeader(
  response: import("node:http").ServerResponse,
  timings: Record<string, number>,
): void {
  response.setHeader("Server-Timing", formatServerTiming(timings));
}

function realtimeTokenProxy(env: Record<string, string>): Plugin {
  return {
    name: "openlogo-realtime-token-proxy",
    configureServer(server) {
      server.middlewares.use(
        "/api/realtime-token",
        async (request, response) => {
          if (request.method !== "POST") {
            response.statusCode = 405;
            response.end("Method not allowed");
            return;
          }

          const resource = env.OPENLOGO_REALTIME_RESOURCE;
          const model = env.OPENLOGO_REALTIME_DEPLOYMENT;
          const voice = env.OPENLOGO_REALTIME_VOICE;
          const transcriptionModel =
            env.OPENLOGO_REALTIME_TRANSCRIPTION_DEPLOYMENT;
          if (!resource || !model || !voice || !transcriptionModel) {
            response.statusCode = 503;
            response.setHeader("content-type", "application/json");
            response.end(
              JSON.stringify({
                error: "Realtime voice tutor is not configured.",
              }),
            );
            return;
          }

          const endpoint = `https://${resource}.openai.azure.com/openai/v1/realtime/client_secrets`;
          try {
            const accessToken = await getAzureAccessToken(
              env,
              "https://ai.azure.com/.default",
            );
            const tokenResponse = await fetch(endpoint, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                Authorization: `Bearer ${accessToken}`,
              },
              body: JSON.stringify({
                session: {
                  type: "realtime",
                  model,
                  audio: { output: { voice } },
                },
              }),
            });
            const responseText = await tokenResponse.text();
            if (!tokenResponse.ok) {
              response.statusCode = tokenResponse.status;
              response.setHeader(
                "content-type",
                tokenResponse.headers.get("content-type") ?? "application/json",
              );
              response.end(responseText);
              return;
            }

            const token = JSON.parse(responseText) as {
              value?: unknown;
              expires_at?: unknown;
            };
            if (
              typeof token.value !== "string" ||
              typeof token.expires_at !== "number"
            ) {
              throw new Error(
                "Realtime token response did not contain value and expires_at.",
              );
            }
            response.statusCode = 200;
            response.setHeader("content-type", "application/json");
            response.end(
              JSON.stringify({
                value: token.value,
                expiresAt: token.expires_at,
                callsUrl: `https://${resource}.openai.azure.com/openai/v1/realtime/calls`,
                model,
                voice,
                transcriptionModel,
              }),
            );
          } catch (error) {
            response.statusCode = 502;
            response.setHeader("content-type", "application/json");
            response.end(
              JSON.stringify({
                error:
                  error instanceof Error
                    ? error.message
                    : "Realtime token request failed.",
              }),
            );
          }
        },
      );
    },
  };
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
    plugins: [boardRecognitionProxy(env), realtimeTokenProxy(env)],
    build: {
      outDir: "web-dist",
    },
  };
});
