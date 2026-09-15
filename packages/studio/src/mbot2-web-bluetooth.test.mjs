import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMBot2ScriptFrame,
  connectMBot2WebBluetooth,
  MBOT2_MODE_WITH_RESPONSE,
  MBOT2_NOTIFY_CHARACTERISTIC_UUID,
  MBOT2_ONLINE_MODE_FRAME,
  MBOT2_SERVICE_UUID,
  MBOT2_WRITE_CHARACTERISTIC_UUID,
} from "@openlogo/studio";

function createBluetoothFake({
  deviceName = "CyberPi test",
  failWrite = false,
  serviceDiscoveryDisconnects = 0,
  serviceDiscoveryLeavesConnected = false,
} = {}) {
  const writes = [];
  const delays = [];
  const requestedCharacteristics = [];
  let notificationListener = () => undefined;
  let disconnectListener = () => undefined;
  let connected = true;
  let connectCount = 0;
  let serviceDiscoveryCount = 0;
  const notifyCharacteristic = {
    async startNotifications() {},
    async write() {},
    subscribe(listener) {
      notificationListener = listener;
      return () => {
        notificationListener = () => undefined;
      };
    },
  };
  const writeCharacteristic = {
    async startNotifications() {},
    async write(bytes) {
      if (failWrite) throw new Error("write failed");
      writes.push([...bytes]);
    },
    subscribe() {
      return () => undefined;
    },
  };
  const device = {
    name: deviceName,
    get connected() {
      return connected;
    },
    async connect() {
      connected = true;
      connectCount += 1;
      return {
        async getPrimaryService(serviceUuid) {
          serviceDiscoveryCount += 1;
          if (serviceDiscoveryCount <= serviceDiscoveryDisconnects) {
            if (!serviceDiscoveryLeavesConnected) connected = false;
            throw new Error(
              "GATT Server is disconnected. Cannot retrieve services.",
            );
          }
          assert.equal(serviceUuid, MBOT2_SERVICE_UUID);
          return {
            async getCharacteristic(characteristicUuid) {
              requestedCharacteristics.push(characteristicUuid);
              return characteristicUuid === MBOT2_NOTIFY_CHARACTERISTIC_UUID
                ? notifyCharacteristic
                : writeCharacteristic;
            },
          };
        },
      };
    },
    disconnect() {
      connected = false;
    },
    subscribeToDisconnect(listener) {
      disconnectListener = listener;
      return () => {
        disconnectListener = () => undefined;
      };
    },
  };
  let requestOptions;
  return {
    delays,
    device,
    requestedCharacteristics,
    writes,
    emitNotification(bytes) {
      notificationListener(bytes);
    },
    emitDisconnect() {
      connected = false;
      disconnectListener();
    },
    async requestDevice(options) {
      requestOptions = options;
      return device;
    },
    get requestOptions() {
      return requestOptions;
    },
    get connectCount() {
      return connectCount;
    },
    async delay(milliseconds) {
      delays.push(milliseconds);
      if (milliseconds === 3_000) {
        return new Promise(() => undefined);
      }
    },
  };
}

test("connect requests the mBot2 service and sends the live-mode handshake", async () => {
  const fake = createBluetoothFake();
  const transport = await connectMBot2WebBluetooth(fake.requestDevice, {
    delay: fake.delay,
  });

  assert.equal(MBOT2_SERVICE_UUID, "0000ffe1-0000-1000-8000-00805f9b34fb");
  assert.deepEqual(fake.requestOptions.optionalServices, [MBOT2_SERVICE_UUID]);
  assert.deepEqual(
    fake.requestOptions.filters.map(({ namePrefix }) => namePrefix),
    ["Makeblock", "CyberPi", "mBot", "BlueFi"],
  );
  assert.deepEqual(fake.requestedCharacteristics, [
    MBOT2_NOTIFY_CHARACTERISTIC_UUID,
    MBOT2_WRITE_CHARACTERISTIC_UUID,
  ]);
  assert.deepEqual(fake.writes, [[...MBOT2_ONLINE_MODE_FRAME]]);
  assert.ok(fake.delays.includes(500));
  assert.equal(transport.deviceName, "CyberPi test");
  assert.equal(transport.connected, true);
});

test("connect retries once when GATT disconnects during service discovery", async () => {
  const fake = createBluetoothFake({ serviceDiscoveryDisconnects: 1 });

  const transport = await connectMBot2WebBluetooth(fake.requestDevice, {
    delay: fake.delay,
  });

  assert.equal(fake.connectCount, 2);
  assert.equal(transport.connected, true);
});

test("connect retries when service discovery leaves a stale connected flag", async () => {
  const fake = createBluetoothFake({
    serviceDiscoveryDisconnects: 1,
    serviceDiscoveryLeavesConnected: true,
  });

  const transport = await connectMBot2WebBluetooth(fake.requestDevice, {
    delay: fake.delay,
  });

  assert.equal(fake.connectCount, 2);
  assert.equal(transport.connected, true);
});

test("connect stops after one service-discovery reconnect", async () => {
  const fake = createBluetoothFake({ serviceDiscoveryDisconnects: 2 });

  await assert.rejects(
    connectMBot2WebBluetooth(fake.requestDevice, { delay: fake.delay }),
    /GATT Server is disconnected/,
  );

  assert.equal(fake.connectCount, 2);
  assert.equal(fake.device.connected, false);
});

test("writes frames in paced 20-byte chunks and routes indexed responses", async () => {
  const fake = createBluetoothFake();
  const transport = await connectMBot2WebBluetooth(fake.requestDevice, {
    delay: fake.delay,
  });
  fake.writes.length = 0;

  const evaluation = transport.evaluate("cyberpi.ultrasonic2.get(1)");
  await new Promise((resolve) => setImmediate(resolve));
  await transport.run("mbot2.EM_stop()");
  const responseFrame = buildMBot2ScriptFrame(
    '{"ret":42}',
    1,
    MBOT2_MODE_WITH_RESPONSE,
  );
  fake.emitNotification(responseFrame);

  assert.equal(await evaluation, 42);
  assert.ok(fake.writes.every((chunk) => chunk.length <= 20));
  assert.ok(fake.delays.includes(8));
  const flattenedWrites = fake.writes.flat();
  assert.ok(flattenedWrites.includes("m".charCodeAt(0)));
});

test("disconnect resolves pending reads and rejects later writes", async () => {
  const fake = createBluetoothFake();
  const transport = await connectMBot2WebBluetooth(fake.requestDevice, {
    delay: fake.delay,
  });
  const evaluation = transport.evaluate("cyberpi.get_battery()");
  await new Promise((resolve) => setImmediate(resolve));

  fake.emitDisconnect();

  assert.equal(await evaluation, undefined);
  assert.equal(transport.connected, false);
  await assert.rejects(transport.run("mbot2.EM_stop()"), /not connected/);
  transport.disconnect();
});

test("explicit disconnect cleans up once and uses the fallback device name", async () => {
  const fake = createBluetoothFake({ deviceName: null });
  const transport = await connectMBot2WebBluetooth(fake.requestDevice, {
    delay: fake.delay,
  });

  assert.equal(transport.deviceName, "mBot2");
  transport.disconnect();
  transport.disconnect();
  assert.equal(transport.connected, false);
  await assert.rejects(transport.run("mbot2.EM_stop()"), /not connected/);
});

test("evaluation times out and ignores responses without a pending request", async () => {
  const fake = createBluetoothFake();
  const transport = await connectMBot2WebBluetooth(fake.requestDevice, {
    delay: fake.delay,
    responseTimeoutMilliseconds: 1,
  });

  const unrelatedResponse = buildMBot2ScriptFrame(
    '{"ret":99}',
    99,
    MBOT2_MODE_WITH_RESPONSE,
  );
  fake.emitNotification(unrelatedResponse);
  assert.equal(await transport.evaluate("cyberpi.get_battery()"), undefined);
});

test("write failures reject connection and evaluation", async () => {
  const connectionFake = createBluetoothFake({ failWrite: true });
  await assert.rejects(
    connectMBot2WebBluetooth(connectionFake.requestDevice, {
      delay: connectionFake.delay,
    }),
    /write failed/,
  );
  assert.equal(connectionFake.device.connected, false);

  const fake = createBluetoothFake();
  const transport = await connectMBot2WebBluetooth(fake.requestDevice, {
    delay: fake.delay,
  });
  fake.device.disconnect();
  await assert.rejects(
    transport.evaluate("cyberpi.get_battery()"),
    /not connected/,
  );
});

test("default dependencies support a multi-chunk command", async () => {
  const fake = createBluetoothFake();
  const transport = await connectMBot2WebBluetooth(fake.requestDevice);
  fake.writes.length = 0;

  await transport.run("x".repeat(30));
  assert.equal(fake.writes.length, 3);
});
