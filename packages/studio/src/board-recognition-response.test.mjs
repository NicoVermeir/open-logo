import assert from "node:assert/strict";
import test from "node:test";
import {
  modelErrorMessage,
  parseBoardRecognitionResponse,
} from "@openlogo/studio";

test("model errors preserve structured and plain-text upstream details", () => {
  assert.equal(
    modelErrorMessage('{"error":"quota exceeded"}', 429),
    "quota exceeded",
  );
  assert.equal(
    modelErrorMessage('{"error":{"message":"model unavailable"}}', 503),
    "model unavailable",
  );
  assert.equal(
    modelErrorMessage("<html>gateway failure</html>", 502),
    "<html>gateway failure</html>",
  );
  assert.equal(
    modelErrorMessage("{}", 500),
    "LLM service returned status 500.",
  );
});

test("recognition responses preserve failures and reject malformed successes", () => {
  assert.throws(
    () => parseBoardRecognitionResponse("upstream unavailable", false),
    /upstream unavailable/,
  );
  assert.throws(
    () => parseBoardRecognitionResponse('{"error":"capacity reached"}', false),
    /capacity reached/,
  );
  assert.throws(
    () =>
      parseBoardRecognitionResponse(
        '{"error":{"message":"model unavailable"}}',
        false,
      ),
    /model unavailable/,
  );
  assert.throws(
    () => parseBoardRecognitionResponse("not json", true),
    /invalid JSON/,
  );
  assert.deepEqual(parseBoardRecognitionResponse('{"blocks":[]}', true), {
    blocks: [],
  });
});

test("missing model error details produce stable fallback messages", () => {
  for (const response of ["null", "false", "3", "{}", '{"error":null}', '{"error":{}}', '{"error":3}', "   "]) {
    assert.equal(modelErrorMessage(response, 503), "LLM service returned status 503.");
    assert.throws(() => parseBoardRecognitionResponse(response, false),
      response.trim() ? /request failed/ : /invalid JSON/);
  }
});
