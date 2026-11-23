import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import {
  DEFAULT_SENSING_CONFIG,
  parseEsp32CsiLine,
  SignalProcessor,
} from '../shared/signalProcessor';
import {
  CalibrationProfile,
  DetectionEvent,
  NetworkEnvironmentInfo,
  PresenceState,
  ProcessedSample,
  RawTelemetryFrame,
  SensingConfig,
  SensorSourceType,
  SessionExportPayload,
  SourceStatus,
} from '../shared/types';
import { Esp32UdpSensor } from './sensors/esp32UdpSensor';
import { ModemLanSensor } from './sensors/modemLanSensor';
import { WindowsWifiSensor } from './sensors/windowsWifiSensor';

let mainWindow: BrowserWindow | null = null;

const processor = new SignalProcessor(DEFAULT_SENSING_CONFIG);
const windowsWifi = new WindowsWifiSensor();
const modemLan = new ModemLanSensor();
const esp32Udp = new Esp32UdpSensor();

let activeSource: SensorSourceType = 'windows-wifi';
let isRunning = true;
let calibrationTimer: NodeJS.Timeout | null = null;
let lastPresenceState: PresenceState = 'EMPTY';
let packetTimestamps: number[] = [];
let cachedNetworkInfo: NetworkEnvironmentInfo = {
  hasWifiAdapter: false,
  wlansvcRunning: false,
  wifiStatusDetail: 'Inspecting local adapters...',
  defaultGateway: null,
  gatewayMac: null,
  gatewayVendor: null,
  localIp: null,
  primaryAdapter: null,
  adapters: [],
  lanHosts: [],
  nearbyWifiNetworks: [],
};

let currentStatus: SourceStatus = {
  source: 'windows-wifi',
  connected: false,
  running: true,
  packetRateHz: 0,
  detail: 'Probing hardware interfaces...',
};

function emitToRenderer(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function createEvent(
  type: DetectionEvent['type'],
  message: string,
  extra: Partial<DetectionEvent> = {}
): DetectionEvent {
  const evt: DetectionEvent = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    type,
    message,
    ...extra,
  };
  emitToRenderer('sensing:event', evt);
  return evt;
}

function computePacketRateHz(now: number): number {
  packetTimestamps.push(now);
  const cutoff = now - 5000;
  while (packetTimestamps.length > 0 && packetTimestamps[0] < cutoff) {
    packetTimestamps.shift();
  }
  if (packetTimestamps.length < 2) return 0;
  const spanSec = Math.max(0.2, (now - packetTimestamps[0]) / 1000);
  return Number((packetTimestamps.length / spanSec).toFixed(1));
}

function updateStatus(patch: Partial<SourceStatus>): void {
  currentStatus = { ...currentStatus, ...patch };
  emitToRenderer('sensing:status', currentStatus);
}

function handleTelemetryFrame(frame: RawTelemetryFrame): void {
  if (!isRunning) return;

  const rateHz = computePacketRateHz(frame.timestamp);
  const sample: ProcessedSample = processor.process(frame);

  if (sample.presenceState !== lastPresenceState) {
    const prev = lastPresenceState;
    lastPresenceState = sample.presenceState;
    createEvent(
      'STATE_CHANGE',
      `State transitioned: ${prev} -> ${sample.presenceState}`,
      {
        fromState: prev,
        toState: sample.presenceState,
        motionIndex: sample.motionIndex,
        confidence: sample.confidence,
      }
    );
  }

  if (currentStatus.packetRateHz !== rateHz) {
    currentStatus = { ...currentStatus, packetRateHz: rateHz };
    emitToRenderer('sensing:status', currentStatus);
  }

  emitToRenderer('sensing:sample', {
    sample,
    ssid: frame.ssid,
    bssid: frame.bssid,
    linkQualityPct: frame.linkQualityPct,
    radioType: frame.radioType,
    channel: frame.channel,
    targetIp: frame.targetIp,
    calibrating: processor.isCalibrating(),
    calibrationSamples: processor.getCalibrationSampleCount(),
  });
}

function stopAllSensors(): void {
  windowsWifi.stop();
  modemLan.stop();
  esp32Udp.stop();
  packetTimestamps = [];
}

function startActiveSource(): void {
  stopAllSensors();
  const cfg = processor.getConfig();

  if (!isRunning) {
    updateStatus({
      source: activeSource,
      running: false,
      packetRateHz: 0,
      detail: 'Capture stopped by user',
    });
    return;
  }

  if (activeSource === 'windows-wifi') {
    updateStatus({
      source: 'windows-wifi',
      connected: false,
      running: true,
      detail: 'Querying Windows WLAN interface (netsh wlan)...',
      error: undefined,
    });
    windowsWifi.start(450, cfg.pingTarget, (reading) => {
      updateStatus({
        source: 'windows-wifi',
        connected: reading.connected,
        running: isRunning,
        detail: reading.detail,
        error: reading.error,
      });
      if (reading.frame) {
        handleTelemetryFrame(reading.frame);
      }
    });
    return;
  }

  if (activeSource === 'modem-lan') {
    updateStatus({
      source: 'modem-lan',
      connected: false,
      running: true,
      detail: `Probing modem / LAN target (${cfg.pingTarget})...`,
      error: undefined,
    });
    modemLan.start(cfg.lanPollMs, cfg.pingTarget, (reading) => {
      updateStatus({
        source: 'modem-lan',
        connected: reading.connected,
        running: isRunning,
        detail: reading.detail,
        error: reading.error,
      });
      if (reading.frame) {
        handleTelemetryFrame(reading.frame);
      }
    });
    return;
  }

  if (activeSource === 'esp32-udp') {
    updateStatus({
      source: 'esp32-udp',
      connected: false,
      running: true,
      detail: `Listening on UDP 0.0.0.0:${cfg.udpPort} for ESP32 CSI packets...`,
      error: undefined,
    });
    esp32Udp.start(
      cfg.udpPort,
      (frame) => {
        handleTelemetryFrame(frame);
      },
      (connected, detail, error) => {
        updateStatus({
          source: 'esp32-udp',
          connected,
          running: isRunning,
          detail,
          error,
        });
      }
    );
    return;
  }

  if (activeSource === 'esp32-serial') {
    updateStatus({
      source: 'esp32-serial',
      connected: false,
      running: true,
      detail: 'Waiting for USB COM port selection in toolbar',
      error: undefined,
    });
  }
}

async function refreshNetworkEnvironment(activeSweep = false): Promise<NetworkEnvironmentInfo> {
  const [lanInfo, wifiScan] = await Promise.all([
    modemLan.inspectNetwork(activeSweep),
    windowsWifi.scanNetworks(),
  ]);

  cachedNetworkInfo = {
    hasWifiAdapter: wifiScan.hasWifiAdapter || lanInfo.adapters.some((a) => a.isWireless),
    wlansvcRunning: wifiScan.wlansvcRunning,
    wifiStatusDetail: wifiScan.detail,
    defaultGateway: lanInfo.defaultGateway,
    gatewayMac: lanInfo.gatewayMac,
    gatewayVendor: lanInfo.gatewayVendor,
    localIp: lanInfo.localIp,
    primaryAdapter: lanInfo.primaryAdapter,
    adapters: lanInfo.adapters,
    lanHosts: lanInfo.lanHosts,
    nearbyWifiNetworks: wifiScan.networks,
  };
  emitToRenderer('sensing:network-info', cachedNetworkInfo);
  return cachedNetworkInfo;
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 1060,
    minHeight: 700,
    backgroundColor: '#f1f4f8',
    title: 'Wi-Fi Human Presence & Motion Sensing System',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.webContents.session.setPermissionCheckHandler((_wc, permission) => {
    if (permission === 'serial') return true;
    return false;
  });

  mainWindow.webContents.session.on(
    'select-serial-port',
    (event, portList, _webContents, callback) => {
      event.preventDefault();
      if (portList && portList.length > 0) {
        const preferred =
          portList.find((p) =>
            /cp210|ch340|ftdi|esp32|usb|uart/i.test(
              `${p.displayName ?? ''} ${p.portName ?? ''}`
            )
          ) ?? portList[0];
        callback(preferred.portId);
      } else {
        callback('');
      }
    }
  );

  const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
  const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';

  if (isDev) {
    mainWindow.loadURL(devUrl).catch(() => {
      void mainWindow?.loadFile(path.join(__dirname, '../../dist/index.html'));
    });
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerIpcHandlers(): void {
  ipcMain.handle('sensing:get-init-state', () => ({
    source: activeSource,
    running: isRunning,
    config: processor.getConfig(),
    calibration: processor.getCalibration(),
    status: currentStatus,
    networkInfo: cachedNetworkInfo,
  }));

  ipcMain.handle('sensing:get-network-info', async (_event, activeSweep = true) => {
    return await refreshNetworkEnvironment(Boolean(activeSweep));
  });

  ipcMain.handle('sensing:set-source', (_event, source: SensorSourceType) => {
    activeSource = source;
    processor.reset();
    lastPresenceState = 'EMPTY';
    createEvent('CONNECTION', `Switched telemetry source to ${source}`);
    startActiveSource();
    return currentStatus;
  });

  ipcMain.handle('sensing:set-running', (_event, running: boolean) => {
    isRunning = running;
    startActiveSource();
    return isRunning;
  });

  ipcMain.handle('sensing:update-config', (_event, partial: Partial<SensingConfig>) => {
    const prevPort = processor.getConfig().udpPort;
    const prevTarget = processor.getConfig().pingTarget;
    const prevPoll = processor.getConfig().lanPollMs;
    processor.updateConfig(partial);
    const updated = processor.getConfig();
    if (
      activeSource === 'esp32-udp' &&
      partial.udpPort !== undefined &&
      partial.udpPort !== prevPort
    ) {
      startActiveSource();
    } else if (
      activeSource === 'modem-lan' &&
      ((partial.pingTarget !== undefined && partial.pingTarget !== prevTarget) ||
        (partial.lanPollMs !== undefined && partial.lanPollMs !== prevPoll))
    ) {
      startActiveSource();
    }
    return updated;
  });

  ipcMain.handle('sensing:start-calibration', (_event, durationMs = 4500) => {
    if (calibrationTimer) {
      clearTimeout(calibrationTimer);
      calibrationTimer = null;
    }
    processor.startCalibration();
    createEvent('CALIBRATION', 'Started baseline calibration...');

    calibrationTimer = setTimeout(() => {
      const profile: CalibrationProfile = processor.finishCalibration();
      emitToRenderer('sensing:calibration', profile);
      const baseText =
        activeSource === 'modem-lan'
          ? `${profile.baselineRttMs} ms`
          : `${profile.baselineRssi} dBm`;
      createEvent(
        'CALIBRATION',
        `Calibration complete: baseline ${baseText} (std=${profile.baselineStd}, ${profile.sampleCount} samples)`
      );
      calibrationTimer = null;
    }, Math.max(1500, durationMs));

    return true;
  });

  ipcMain.handle('sensing:ingest-serial-line', (_event, line: string) => {
    if (activeSource !== 'esp32-serial') return false;
    const parsed = parseEsp32CsiLine(line);
    if (!parsed) return false;
    handleTelemetryFrame({
      timestamp: Date.now(),
      source: 'esp32-serial',
      rssi: parsed.rssi,
      rttMs: parsed.rttMs,
      csiAmplitudes: parsed.csiAmplitudes,
      ssid: 'ESP32-USB-SERIAL',
    });
    return true;
  });

  ipcMain.handle(
    'sensing:set-serial-status',
    (_event, connected: boolean, detail: string, error?: string) => {
      if (activeSource === 'esp32-serial') {
        updateStatus({
          source: 'esp32-serial',
          connected,
          running: isRunning,
          detail,
          error,
        });
      }
      return true;
    }
  );

  ipcMain.handle(
    'sensing:export-session',
    async (_event, format: 'csv' | 'json', payload: SessionExportPayload) => {
      if (!mainWindow) return { canceled: true };
      const defaultName = `wifi-sensing-session-${new Date()
        .toISOString()
        .replace(/[:.]/g, '-')}.${format}`;
      const result = await dialog.showSaveDialog(mainWindow, {
        title: `Export Session as ${format.toUpperCase()}`,
        defaultPath: defaultName,
        filters: [
          format === 'csv'
            ? { name: 'CSV Telemetry', extensions: ['csv'] }
            : { name: 'JSON Session', extensions: ['json'] },
        ],
      });

      if (result.canceled || !result.filePath) {
        return { canceled: true };
      }

      if (format === 'json') {
        await fs.writeFile(result.filePath, JSON.stringify(payload, null, 2), 'utf8');
      } else {
        const header =
          'timestamp,iso_time,metric_mode,raw_primary,filtered_primary,baseline_primary,primary_unit,raw_rssi_dbm,filtered_rssi_dbm,variance,csi_turbulence,motion_index,presence_state,confidence_pct,rtt_ms\n';
        const rows = payload.samples
          .map((s) =>
            [
              s.timestamp,
              new Date(s.timestamp).toISOString(),
              s.metricMode,
              s.rawPrimary,
              s.filteredPrimary,
              s.baselinePrimary,
              s.primaryUnit,
              s.rawRssi ?? '',
              s.filteredRssi ?? '',
              s.variance,
              s.csiTurbulence,
              s.motionIndex,
              s.presenceState,
              s.confidence,
              s.rttMs ?? '',
            ].join(',')
          )
          .join('\n');
        await fs.writeFile(result.filePath, header + rows, 'utf8');
      }

      createEvent(
        'ALERT',
        `Exported ${payload.samples.length} samples to ${path.basename(result.filePath)}`
      );
      return { canceled: false, filePath: result.filePath };
    }
  );
}

app.whenReady().then(async () => {
  registerIpcHandlers();
  const netInfo = await refreshNetworkEnvironment(true);
  if (netInfo.hasWifiAdapter) {
    const wifiCheck = await windowsWifi.pollOnce('auto');
    activeSource = wifiCheck.connected ? 'windows-wifi' : netInfo.defaultGateway ? 'modem-lan' : 'windows-wifi';
  } else if (netInfo.defaultGateway) {
    activeSource = 'modem-lan';
  } else {
    activeSource = 'windows-wifi';
  }

  createWindow();
  startActiveSource();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  stopAllSensors();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
