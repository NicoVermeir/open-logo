import {
  buildMBot2ScriptFrame,
  MBot2ResponseParser,
  MBOT2_MODE_NO_RESPONSE,
  MBOT2_MODE_WITH_RESPONSE,
  MBOT2_ONLINE_MODE_FRAME,
} from "./mbot2-protocol.js";

export const MBOT2_SERVICE_UUID = "0000ffe1-0000-1000-8000-00805f9b34fb";
export const MBOT2_NOTIFY_CHARACTERISTIC_UUID =
  "0000ffe2-0000-1000-8000-00805f9b34fb";
export const MBOT2_WRITE_CHARACTERISTIC_UUID =
  "0000ffe3-0000-1000-8000-00805f9b34fb";

const DEVICE_NAME_PREFIXES = ["Makeblock", "CyberPi", "mBot", "BlueFi"];
const WRITE_CHUNK_SIZE = 20;
const WRITE_CHUNK_DELAY_MILLISECONDS = 8;
const ONLINE_MODE_SETTLE_DELAY_MILLISECONDS = 500;

export interface MBot2BluetoothRequestOptions {
  readonly filters: readonly { readonly namePrefix: string }[];
  readonly optionalServices: readonly string[];
}

export interface MBot2BluetoothCharacteristic {
  startNotifications(): Promise<void>;
  write(bytes: Uint8Array): Promise<void>;
  subscribe(listener: (bytes: Uint8Array) => void): () => void;
}

export interface MBot2BluetoothService {
  getCharacteristic(
    characteristicUuid: string,
  ): Promise<MBot2BluetoothCharacteristic>;
}

export interface MBot2BluetoothServer {
  getPrimaryService(serviceUuid: string): Promise<MBot2BluetoothService>;
}

export interface MBot2BluetoothDevice {
  readonly name?: string;
  readonly connected: boolean;
  connect(): Promise<MBot2BluetoothServer>;
  disconnect(): void;
  subscribeToDisconnect(listener: () => void): () => void;
}

export type MBot2RequestDevice = (
  options: MBot2BluetoothRequestOptions,
) => Promise<MBot2BluetoothDevice>;

export interface MBot2WebBluetoothDependencies {
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly responseTimeoutMilliseconds?: number;
}

export interface MBot2WebBluetoothTransport {
  readonly deviceName: string;
  readonly connected: boolean;
  run(script: string): Promise<void>;
  evaluate(expression: string): Promise<unknown | undefined>;
  disconnect(): void;
}

interface PendingResponse {
  readonly resolve: (value: unknown | undefined) => void;
}

export async function connectMBot2WebBluetooth(
  requestDevice: MBot2RequestDevice,
  dependencies: MBot2WebBluetoothDependencies = {},
): Promise<MBot2WebBluetoothTransport> {
  const device = await requestDevice({
    filters: DEVICE_NAME_PREFIXES.map((namePrefix) => ({ namePrefix })),
    optionalServices: [MBOT2_SERVICE_UUID],
  });
  try {
    const service = await connectPrimaryService(device);
    const [notifyCharacteristic, writeCharacteristic] = await Promise.all([
      service.getCharacteristic(MBOT2_NOTIFY_CHARACTERISTIC_UUID),
      service.getCharacteristic(MBOT2_WRITE_CHARACTERISTIC_UUID),
    ]);
    await notifyCharacteristic.startNotifications();

    return createConnectedTransport(
      device,
      notifyCharacteristic,
      writeCharacteristic,
      dependencies,
    );
  } catch (error) {
    device.disconnect();
    throw error;
  }
}

async function connectPrimaryService(
  device: MBot2BluetoothDevice,
): Promise<MBot2BluetoothService> {
  let server = await device.connect();
  try {
    return await server.getPrimaryService(MBOT2_SERVICE_UUID);
  } catch {
    device.disconnect();
    server = await device.connect();
    return server.getPrimaryService(MBOT2_SERVICE_UUID);
  }
}

function createConnectedTransport(
  device: MBot2BluetoothDevice,
  notifyCharacteristic: MBot2BluetoothCharacteristic,
  writeCharacteristic: MBot2BluetoothCharacteristic,
  dependencies: MBot2WebBluetoothDependencies,
): Promise<MBot2WebBluetoothTransport> {
  const delay = dependencies.delay ?? defaultDelay;
  const responseTimeoutMilliseconds =
    dependencies.responseTimeoutMilliseconds ?? 3_000;
  const parser = new MBot2ResponseParser();
  const pendingResponses = new Map<number, PendingResponse>();
  let requestIndex = 1;
  let writeQueue = Promise.resolve();
  let disposed = false;

  const finishPendingResponses = (): void => {
    for (const pending of pendingResponses.values()) {
      pending.resolve(undefined);
    }
    pendingResponses.clear();
  };
  const unsubscribeNotifications = notifyCharacteristic.subscribe((bytes) => {
    for (const response of parser.feed(bytes)) {
      const pending = pendingResponses.get(response.index);
      if (pending !== undefined) {
        pendingResponses.delete(response.index);
        pending.resolve(response.value);
      }
    }
  });
  const unsubscribeDisconnect = device.subscribeToDisconnect(() => {
    disposed = true;
    finishPendingResponses();
  });

  const nextRequestIndex = (): number => {
    const current = requestIndex;
    requestIndex = (requestIndex % 0xfffe) + 1;
    return current;
  };
  const write = (frame: Uint8Array): Promise<void> => {
    const queuedWrite = writeQueue.then(async () => {
      if (disposed || !device.connected) {
        throw new Error("The mBot2 is not connected.");
      }
      for (let offset = 0; offset < frame.length; offset += WRITE_CHUNK_SIZE) {
        await writeCharacteristic.write(
          frame.slice(offset, offset + WRITE_CHUNK_SIZE),
        );
        if (offset + WRITE_CHUNK_SIZE < frame.length) {
          await delay(WRITE_CHUNK_DELAY_MILLISECONDS);
        }
      }
    });
    writeQueue = queuedWrite.catch(() => undefined);
    return queuedWrite;
  };

  const transport: MBot2WebBluetoothTransport = {
    deviceName: device.name ?? "mBot2",
    get connected() {
      return !disposed && device.connected;
    },
    async run(script) {
      await write(
        buildMBot2ScriptFrame(
          script,
          nextRequestIndex(),
          MBOT2_MODE_NO_RESPONSE,
        ),
      );
    },
    async evaluate(expression) {
      const index = nextRequestIndex();
      let resolveResponse!: (value: unknown | undefined) => void;
      const response = new Promise<unknown | undefined>((resolve) => {
        resolveResponse = resolve;
      });
      pendingResponses.set(index, { resolve: resolveResponse });
      try {
        await write(
          buildMBot2ScriptFrame(expression, index, MBOT2_MODE_WITH_RESPONSE),
        );
      } catch (error) {
        pendingResponses.delete(index);
        throw error;
      }
      const timeout = delay(responseTimeoutMilliseconds).then(() => undefined);
      const value = await Promise.race([response, timeout]);
      pendingResponses.delete(index);
      return value;
    },
    disconnect() {
      if (!disposed) {
        disposed = true;
        unsubscribeNotifications();
        unsubscribeDisconnect();
        finishPendingResponses();
        device.disconnect();
      }
    },
  };

  return write(MBOT2_ONLINE_MODE_FRAME).then(
    async () => {
      await delay(ONLINE_MODE_SETTLE_DELAY_MILLISECONDS);
      return transport;
    },
    (error: unknown) => {
      transport.disconnect();
      throw error;
    },
  );
}

function defaultDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const host = globalThis as unknown as {
      setTimeout(callback: () => void, delay: number): unknown;
    };
    host.setTimeout(resolve, milliseconds);
  });
}
