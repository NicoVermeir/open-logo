import assert from "node:assert/strict";
import test from "node:test";
import {
  createAccessTokenCache,
  formatServerTiming,
} from "./vite-access-token-cache.mjs";

function tokenExpiringAt(expirySeconds, marker) {
  const payload = Buffer.from(JSON.stringify({ exp: expirySeconds })).toString(
    "base64url",
  );
  return `header.${payload}.${marker}`;
}

test("access token cache reuses valid tokens and refreshes near expiry", async () => {
  let nowMilliseconds = 1_000_000;
  let acquisitionCount = 0;
  const cache = createAccessTokenCache({ now: () => nowMilliseconds });
  const acquireToken = async () => {
    acquisitionCount += 1;
    return tokenExpiringAt(nowMilliseconds / 1_000 + 300, acquisitionCount);
  };

  const first = await cache.get("scope|tenant", acquireToken);
  assert.equal(await cache.get("scope|tenant", acquireToken), first);
  assert.equal(acquisitionCount, 1);

  nowMilliseconds += 181_000;
  assert.notEqual(await cache.get("scope|tenant", acquireToken), first);
  assert.equal(acquisitionCount, 2);
});

test("access token cache coalesces concurrent acquisitions", async () => {
  let resolveAcquisition;
  let acquisitionCount = 0;
  const cache = createAccessTokenCache({ now: () => 1_000_000 });
  const acquireToken = () => {
    acquisitionCount += 1;
    return new Promise((resolve) => {
      resolveAcquisition = resolve;
    });
  };

  const first = cache.get("scope|tenant", acquireToken);
  const second = cache.get("scope|tenant", acquireToken);
  resolveAcquisition(tokenExpiringAt(2_000, "shared"));

  assert.equal(await first, await second);
  assert.equal(acquisitionCount, 1);
});

test("access token cache retries failures and does not cache opaque tokens", async () => {
  let acquisitionCount = 0;
  const cache = createAccessTokenCache();
  const acquireToken = async () => {
    acquisitionCount += 1;
    if (acquisitionCount === 1) throw new Error("login required");
    return "opaque-token";
  };

  await assert.rejects(
    cache.get("scope|tenant", acquireToken),
    /login required/,
  );
  assert.equal(await cache.get("scope|tenant", acquireToken), "opaque-token");
  assert.equal(await cache.get("scope|tenant", acquireToken), "opaque-token");
  assert.equal(acquisitionCount, 3);
});

test("server timings use stable names and non-negative durations", () => {
  assert.equal(
    formatServerTiming({ auth: 12.345, model: 98, parse: -2, total: 111.04 }),
    "auth;dur=12.3, model;dur=98.0, parse;dur=0.0, total;dur=111.0",
  );
});
