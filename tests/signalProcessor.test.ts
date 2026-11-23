import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  DEFAULT_SENSING_CONFIG,
  parseEsp32CsiLine,
  SignalProcessor,
} = require('../dist-electron/shared/signalProcessor.js') as typeof import('../src/shared/signalProcessor');
const {
  WifiSignalSimulator,
} = require('../dist-electron/shared/simulator.js') as typeof import('../src/shared/simulator');
const {
  parseNetshInterfacesOutput,
  parsePingRttMs,
} = require('../dist-electron/electron/sensors/windowsWifiSensor.js') as typeof import('../src/electron/sensors/windowsWifiSensor');
const {
  parseArpTable,
  parseIpconfigSummary,
} = require('../dist-electron/electron/sensors/modemLanSensor.js') as typeof import('../src/electron/sensors/modemLanSensor');

test('SignalProcessor classifies empty, stationary presence, and walking motion accurately', () => {
  const processor = new SignalProcessor({
    ...DEFAULT_SENSING_CONFIG,
    hysteresisMs: 0,
  });
  const sim = new WifiSignalSimulator('empty');

  processor.startCalibration();
  let t = 1_000_000;
  for (let i = 0; i < 30; i++) {
    t += 100;
    processor.process(sim.nextFrame(t));
  }
  const cal = processor.finishCalibration();
  assert.equal(cal.isCalibrated, true);
  assert.equal(cal.sampleCount, 30);

  const emptySample = processor.process(sim.nextFrame(t + 100));
  assert.equal(emptySample.presenceState, 'EMPTY');

  sim.setScenario('stationary');
  let stationarySample = emptySample;
  for (let i = 0; i < 35; i++) {
    t += 100;
    stationarySample = processor.process(sim.nextFrame(t));
  }
  assert.ok(
    stationarySample.presenceState === 'PRESENCE' ||
      stationarySample.presenceState === 'MOTION',
    `Expected PRESENCE or MOTION for stationary human, got ${stationarySample.presenceState} (motionIndex=${stationarySample.motionIndex})`
  );
  assert.ok(stationarySample.motionIndex > emptySample.motionIndex);

  sim.setScenario('walking');
  let walkingSample = stationarySample;
  for (let i = 0; i < 30; i++) {
    t += 100;
    walkingSample = processor.process(sim.nextFrame(t));
  }
  assert.equal(walkingSample.presenceState, 'MOTION');
  assert.ok(walkingSample.motionIndex >= DEFAULT_SENSING_CONFIG.motionThreshold);
});

test('SignalProcessor rejects isolated Hampel outlier spikes', () => {
  const processor = new SignalProcessor({ ...DEFAULT_SENSING_CONFIG, windowSize: 12 });
  let t = 5_000;
  for (let i = 0; i < 12; i++) {
    t += 100;
    processor.process({
      timestamp: t,
      source: 'windows-wifi',
      rssi: -52,
    });
  }

  const afterSpike = processor.process({
    timestamp: t + 100,
    source: 'windows-wifi',
    rssi: -95,
  });

  assert.ok(
    afterSpike.filteredRssi !== null && afterSpike.filteredRssi > -56,
    `Expected Hampel filter to reject spike, got filteredRssi=${afterSpike.filteredRssi}`
  );
});

test('SignalProcessor processes RTT-only modem/LAN probes without fabricating RSSI', () => {
  const processor = new SignalProcessor({ ...DEFAULT_SENSING_CONFIG, hysteresisMs: 0 });
  processor.startCalibration();
  let t = 10_000;
  for (let i = 0; i < 15; i++) {
    t += 300;
    processor.process({ timestamp: t, source: 'modem-lan', rttMs: 0.5 });
  }
  const cal = processor.finishCalibration();
  assert.equal(cal.isCalibrated, true);
  assert.equal(cal.baselineRttMs, 0.5);

  const sample = processor.process({ timestamp: t + 300, source: 'modem-lan', rttMs: 0.5 });
  assert.equal(sample.metricMode, 'rtt');
  assert.equal(sample.primaryUnit, 'ms');
  assert.equal(sample.rawRssi, null);
  assert.equal(sample.presenceState, 'EMPTY');
});

test('parseEsp32CsiLine parses both JSON and ESP-CSI CSV formats', () => {
  const jsonParsed = parseEsp32CsiLine('{"rssi":-47,"csi":[18.1,19.4,20.2],"rtt":3.5}');
  assert.ok(jsonParsed);
  assert.equal(jsonParsed.rssi, -47);
  assert.deepEqual(jsonParsed.csiAmplitudes, [18.1, 19.4, 20.2]);
  assert.equal(jsonParsed.rttMs, 3.5);

  const csvLine =
    'CSI_DATA,12,AA:BB:CC:DD:EE:FF,-51,11,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,20,"[3,4,6,8,0,5,12,5,3,4,6,8,0,5,12,5,3,4,6,8]"';
  const csvParsed = parseEsp32CsiLine(csvLine);
  assert.ok(csvParsed);
  assert.equal(csvParsed.rssi, -51);
  assert.ok(csvParsed.csiAmplitudes && csvParsed.csiAmplitudes.length === 10);
  assert.equal(csvParsed.csiAmplitudes[0], 5);
});

test('parseNetshInterfacesOutput extracts SSID, BSSID, State, and Signal', () => {
  const sample = `
There is 1 interface on the system:

    Name                   : Wi-Fi
    Description            : Intel(R) Wi-Fi 6 AX201 160MHz
    State                  : connected
    SSID                   : LabRouter_5G
    AP BSSID               : aa:bb:cc:dd:ee:ff
    Signal                 : 84%
`;
  const parsed = parseNetshInterfacesOutput(sample);
  assert.equal(parsed.state, 'connected');
  assert.equal(parsed.ssid, 'LabRouter_5G');
  assert.equal(parsed.bssid, 'aa:bb:cc:dd:ee:ff');
  assert.equal(parsed.signalPct, 84);
});

test('parseIpconfigSummary, parseArpTable, and parsePingRttMs parse real Windows output', () => {
  const ipconfigSample = `
Ethernet adapter Ethernet:

   Description . . . . . . . . . . . : Example PCIe GbE Controller
   IPv4 Address. . . . . . . . . . . : 192.168.1.50(Preferred)
   Default Gateway . . . . . . . . . : 192.168.1.1
`;
  const net = parseIpconfigSummary(ipconfigSample);
  assert.equal(net.defaultGateway, '192.168.1.1');
  assert.equal(net.localIp, '192.168.1.50');
  assert.equal(net.adapters.length, 1);

  const arpSample = `
Interface: 10.0.0.1 --- 0xd
  10.0.0.200            02-00-00-11-22-33     dynamic

Interface: 192.168.1.50 --- 0x10
  Internet Address      Physical Address      Type
  192.168.1.1           c0-25-e9-11-22-33     dynamic
  192.168.1.105         aa-bb-cc-dd-ee-ff     dynamic
  224.0.0.22            01-00-5e-00-00-16     static
`;
  const hosts = parseArpTable(arpSample, '192.168.1.1', '192.168.1.50');
  assert.equal(hosts.length, 2);
  assert.equal(hosts[0].ip, '192.168.1.1');
  assert.equal(hosts[0].isGateway, true);
  assert.equal(hosts[0].vendor, 'TP-Link');
  assert.equal(hosts[1].ip, '192.168.1.105');

  assert.equal(parsePingRttMs('Reply from 192.168.1.1: bytes=32 time<1ms TTL=64'), 0.5);
  assert.equal(parsePingRttMs('Reply from 192.168.1.105: bytes=32 time=14ms TTL=64'), 14);
});
