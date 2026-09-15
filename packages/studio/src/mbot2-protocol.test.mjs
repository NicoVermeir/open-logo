import assert from "node:assert/strict";
import { test } from "node:test";
import * as OL from "@openlogo/studio";

const { buildMBot2ScriptFrame, MBot2ResponseParser } = OL;

test("buildMBot2ScriptFrame matches the CyberPi script frame format", () => {
  assert.deepEqual(
    [...buildMBot2ScriptFrame("print(1)", 0x1234, 1)],
    [
      0xf3, 0x01, 0x0e, 0x00, 0x28, 0x01, 0x34, 0x12, 0x08, 0x00, 0x70, 0x72,
      0x69, 0x6e, 0x74, 0x28, 0x31, 0x29, 0x26, 0xf4,
    ],
  );
});

test("MBot2ResponseParser finds and reassembles a fragmented response", () => {
  const parser = new MBot2ResponseParser();
  const frame = buildMBot2ScriptFrame('{"ret":42}', 7, 1);

  assert.deepEqual(parser.feed([0xf3, 0x00, 0x01, 0x00]), []);
  assert.deepEqual(parser.feed([0x00, 0x01, ...frame.subarray(0, 5)]), []);
  assert.deepEqual(parser.feed(frame.subarray(5)), [
    { index: 7, value: 42, raw: '{"ret":42}' },
  ]);
});

test("MBot2ResponseParser handles Unicode, fallback values, and malformed frames", () => {
  const parser = new MBot2ResponseParser();

  assert.deepEqual(parser.feed(buildMBot2ScriptFrame('{"ret":"café"}', 1, 1)), [
    { index: 1, value: "café", raw: '{"ret":"café"}' },
  ]);
  assert.deepEqual(parser.feed(buildMBot2ScriptFrame("{'ret': plain}", 2, 1)), [
    { index: 2, value: "plain", raw: "{'ret': plain}" },
  ]);
  assert.deepEqual(parser.feed(buildMBot2ScriptFrame("{'ret': 3}", 8, 1)), [
    { index: 8, value: 3, raw: "{'ret': 3}" },
  ]);
  assert.deepEqual(parser.feed(buildMBot2ScriptFrame("not a result", 3, 1)), [
    { index: 3, value: undefined, raw: "not a result" },
  ]);

  const wrongType = buildMBot2ScriptFrame('{"ret":1}', 4, 1);
  wrongType[4] = 0;
  assert.deepEqual(parser.feed(wrongType), []);

  const shortData = Uint8Array.from([
    0xf3, 0xf7, 0x04, 0x00, 0x28, 0x01, 0x00, 0x00, 0x00, 0xf4,
  ]);
  assert.deepEqual(parser.feed(shortData), []);
});

test("MBot2ResponseParser discards excessive noise and oversized partial frames", () => {
  const parser = new MBot2ResponseParser();
  assert.deepEqual(parser.feed(new Uint8Array(100)), []);

  const oversizedHeader = [0xf3, 0xf1, 0xff, 0xff];
  assert.deepEqual(parser.feed([...oversizedHeader, ...new Uint8Array(4_100)]), []);

  const valid = buildMBot2ScriptFrame('{"ret":true}', 6, 1);
  assert.deepEqual(parser.feed(valid), [
    { index: 6, value: true, raw: '{"ret":true}' },
  ]);

  const invalidUtf8 = buildMBot2ScriptFrame("x", 7, 1);
  invalidUtf8[10] = 0xff;
  assert.deepEqual(parser.feed(invalidUtf8), [
    { index: 7, value: undefined, raw: "�" },
  ]);
});
