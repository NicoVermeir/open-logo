import {
  connectMBot2WebBluetooth,
  createMBot2ManualRobot,
} from "../src/index.js";
import type {
  MBot2BluetoothCharacteristic,
  MBot2BluetoothDevice,
  MBot2BluetoothRequestOptions,
  MBot2BluetoothServer,
  MBot2ManualRobot,
} from "../src/index.js";

interface BrowserBluetoothCharacteristic extends EventTarget {
  readonly value?: DataView;
  startNotifications(): Promise<BrowserBluetoothCharacteristic>;
  writeValueWithoutResponse(value: BufferSource): Promise<void>;
}

interface BrowserBluetoothService {
  getCharacteristic(uuid: string): Promise<BrowserBluetoothCharacteristic>;
}

interface BrowserBluetoothServer {
  readonly connected: boolean;
  connect(): Promise<BrowserBluetoothServer>;
  disconnect(): void;
  getPrimaryService(uuid: string): Promise<BrowserBluetoothService>;
}

interface BrowserBluetoothDevice extends EventTarget {
  readonly name?: string;
  readonly gatt?: BrowserBluetoothServer;
}

interface BrowserBluetooth {
  requestDevice(
    options: MBot2BluetoothRequestOptions,
  ): Promise<BrowserBluetoothDevice>;
}

export function createMBot2BrowserConnector():
  (() => Promise<MBot2ManualRobot>) | undefined {
  const bluetooth = (navigator as Navigator & { bluetooth?: BrowserBluetooth })
    .bluetooth;
  if (bluetooth === undefined) return undefined;
  return async () =>
    createMBot2ManualRobot(
      await connectMBot2WebBluetooth((options) =>
        requestDevice(bluetooth, options),
      ),
    );
}

async function requestDevice(
  bluetooth: BrowserBluetooth,
  options: MBot2BluetoothRequestOptions,
): Promise<MBot2BluetoothDevice> {
  const device = await bluetooth.requestDevice(options);
  const server = device.gatt;
  if (server === undefined)
    throw new Error("The selected robot has no Bluetooth GATT server.");
  return {
    name: device.name,
    get connected() {
      return server.connected;
    },
    async connect(): Promise<MBot2BluetoothServer> {
      const connectedServer = await server.connect();
      return {
        async getPrimaryService(uuid) {
          const discoveryServer = connectedServer.connected
            ? connectedServer
            : await connectedServer.connect();
          const service = await discoveryServer.getPrimaryService(uuid);
          return {
            async getCharacteristic(characteristicUuid) {
              return adaptCharacteristic(
                await service.getCharacteristic(characteristicUuid),
              );
            },
          };
        },
      };
    },
    disconnect: () => server.disconnect(),
    subscribeToDisconnect(listener) {
      device.addEventListener("gattserverdisconnected", listener);
      return () =>
        device.removeEventListener("gattserverdisconnected", listener);
    },
  };
}

function adaptCharacteristic(
  characteristic: BrowserBluetoothCharacteristic,
): MBot2BluetoothCharacteristic {
  return {
    async startNotifications() {
      await characteristic.startNotifications();
    },
    async write(bytes) {
      await characteristic.writeValueWithoutResponse(bytes);
    },
    subscribe(listener) {
      const handleValue = (): void => {
        const value = characteristic.value;
        if (value !== undefined) {
          listener(
            new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
          );
        }
      };
      characteristic.addEventListener(
        "characteristicvaluechanged",
        handleValue,
      );
      return () =>
        characteristic.removeEventListener(
          "characteristicvaluechanged",
          handleValue,
        );
    },
  };
}
