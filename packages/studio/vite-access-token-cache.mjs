const DEFAULT_REFRESH_SKEW_MILLISECONDS = 120_000;

export function createAccessTokenCache(options = {}) {
  const now = options.now ?? Date.now;
  const refreshSkewMilliseconds =
    options.refreshSkewMilliseconds ?? DEFAULT_REFRESH_SKEW_MILLISECONDS;
  const cachedTokens = new Map();
  const pendingAcquisitions = new Map();

  return {
    async get(cacheKey, acquireToken) {
      const cached = cachedTokens.get(cacheKey);
      if (
        cached !== undefined &&
        cached.expiresAtMilliseconds - refreshSkewMilliseconds > now()
      ) {
        return cached.token;
      }

      const pending = pendingAcquisitions.get(cacheKey);
      if (pending !== undefined) return pending;

      const acquisition = acquireToken()
        .then((token) => {
          const expiresAtMilliseconds = tokenExpiryMilliseconds(token);
          if (expiresAtMilliseconds !== undefined) {
            cachedTokens.set(cacheKey, { token, expiresAtMilliseconds });
          }
          return token;
        })
        .finally(() => pendingAcquisitions.delete(cacheKey));
      pendingAcquisitions.set(cacheKey, acquisition);
      return acquisition;
    },
  };
}

export function formatServerTiming(timings) {
  return Object.entries(timings)
    .map(
      ([name, duration]) => `${name};dur=${Math.max(0, duration).toFixed(1)}`,
    )
    .join(", ");
}

function tokenExpiryMilliseconds(token) {
  const payload = token.split(".")[1];
  if (payload === undefined) return undefined;
  try {
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    return typeof claims.exp === "number" ? claims.exp * 1_000 : undefined;
  } catch {
    return undefined;
  }
}
