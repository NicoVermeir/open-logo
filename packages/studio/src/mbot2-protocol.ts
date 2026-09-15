const FRAME_HEADER = 0xf3;
const FRAME_FOOTER = 0xf4;
const SCRIPT_TYPE = 0x28;

export const MBOT2_MODE_NO_RESPONSE = 0x00;
export const MBOT2_MODE_WITH_RESPONSE = 0x01;
export const MBOT2_ONLINE_MODE_FRAME = Uint8Array.from([
  0xf3, 0xf6, 0x03, 0x00, 0x0d, 0x00, 0x01, 0x0e, 0xf4,
]);

export interface MBot2Response {
  readonly index: number;
  readonly value: unknown;
  readonly raw: string;
}

function encodeUtf8(value: string): Uint8Array {
  const encoded = encodeURIComponent(value);
  const bytes: number[] = [];
  for (let index = 0; index < encoded.length; index += 1) {
    if (encoded[index] === "%") {
      bytes.push(Number.parseInt(encoded.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(encoded.charCodeAt(index));
    }
  }
  return Uint8Array.from(bytes);
}

function decodeUtf8(value: Uint8Array): string {
  const encoded = [...value]
    .map((byte) => `%${byte.toString(16).padStart(2, "0")}`)
    .join("");
  try {
    return decodeURIComponent(encoded);
  } catch {
    return "\ufffd";
  }
}

export function buildMBot2ScriptFrame(
  script: string,
  index: number,
  mode: number,
): Uint8Array {
  const scriptBytes = encodeUtf8(script);
  const dataLength = scriptBytes.length + 6;
  const indexLow = index & 0xff;
  const indexHigh = (index >> 8) & 0xff;
  const frame = new Uint8Array(dataLength + 6);

  frame.set([
    FRAME_HEADER,
    ((dataLength >> 8) + (dataLength & 0xff) + FRAME_HEADER) & 0xff,
    dataLength & 0xff,
    (dataLength >> 8) & 0xff,
    SCRIPT_TYPE,
    mode,
    indexLow,
    indexHigh,
    scriptBytes.length & 0xff,
    (scriptBytes.length >> 8) & 0xff,
  ]);
  frame.set(scriptBytes, 10);

  let checksum = SCRIPT_TYPE + mode + indexLow + indexHigh;
  for (const byte of frame.subarray(8, frame.length - 2)) checksum += byte;
  frame[frame.length - 2] = checksum & 0xff;
  frame[frame.length - 1] = FRAME_FOOTER;
  return frame;
}

function parseReturnValue(raw: string): unknown {
  try {
    const parsed = JSON.parse(raw) as { readonly ret?: unknown };
    return parsed.ret;
  } catch {
    const match = /["']ret["']:\s*(.*?)\s*}?$/.exec(raw);
    if (match === null) return undefined;
    const value = match[1]!;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
}

export class MBot2ResponseParser {
  readonly #buffer: number[] = [];
  #receiving = false;
  #dataLength = 0;

  feed(data: Iterable<number>): readonly MBot2Response[] {
    const responses: MBot2Response[] = [];
    for (const byte of data) {
      const response = this.#feedByte(byte);
      if (response !== undefined) responses.push(response);
    }
    return responses;
  }

  #feedByte(byte: number): MBot2Response | undefined {
    this.#buffer.push(byte);
    const length = this.#buffer.length;
    if (
      length > 3 &&
      this.#buffer[length - 4] === FRAME_HEADER &&
      ((this.#buffer[length - 1]! + this.#buffer[length - 2]! + FRAME_HEADER) &
        0xff) ===
        this.#buffer[length - 3]
    ) {
      this.#buffer.splice(0, length - 4);
      this.#dataLength = this.#buffer[2]! + (this.#buffer[3]! << 8);
      this.#receiving = true;
    }

    if (this.#receiving && this.#buffer.length === this.#dataLength + 6) {
      const frame = Uint8Array.from(this.#buffer);
      this.#reset();
      return parseResponseFrame(frame);
    }
    if (this.#receiving && this.#buffer.length > 4096) this.#reset();
    if (!this.#receiving && this.#buffer.length > 64) {
      this.#buffer.splice(0, this.#buffer.length - 4);
    }
    return undefined;
  }

  #reset(): void {
    this.#buffer.length = 0;
    this.#receiving = false;
    this.#dataLength = 0;
  }
}

function parseResponseFrame(frame: Uint8Array): MBot2Response | undefined {
  if (frame.length < 10 || frame[4] !== SCRIPT_TYPE) return undefined;
  const data = frame.subarray(8, frame.length - 2);
  if (data.length < 3) return undefined;
  const raw = decodeUtf8(data.subarray(2));
  return {
    index: frame[6]! + (frame[7]! << 8),
    value: parseReturnValue(raw),
    raw,
  };
}
