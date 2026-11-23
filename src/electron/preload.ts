import { contextBridge, ipcRenderer } from 'electron';
import {
  CalibrationProfile,
  DetectionEvent,
  NetworkEnvironmentInfo,
  ProcessedSample,
  SensingConfig,
  SensorSourceType,
  SessionExportPayload,
  SourceStatus,
} from '../shared/types';

export interface SamplePacket {
  sample: ProcessedSample;
  ssid?: string;
  bssid?: string;
  linkQualityPct?: number;
  radioType?: string;
  channel?: string;
  targetIp?: string;
  calibrating: boolean;
  calibrationSamples: number;
}

export interface InitState {
  source: SensorSourceType;
  running: boolean;
  config: SensingConfig;
  calibration: CalibrationProfile;
  status: SourceStatus;
  networkInfo: NetworkEnvironmentInfo;
}

const sensingApi = {
  getInitState: (): Promise<InitState> => ipcRenderer.invoke('sensing:get-init-state'),
  getNetworkInfo: (activeSweep?: boolean): Promise<NetworkEnvironmentInfo> =>
    ipcRenderer.invoke('sensing:get-network-info', activeSweep),
  setSource: (source: SensorSourceType): Promise<SourceStatus> =>
    ipcRenderer.invoke('sensing:set-source', source),
  setRunning: (running: boolean): Promise<boolean> =>
    ipcRenderer.invoke('sensing:set-running', running),
  updateConfig: (partial: Partial<SensingConfig>): Promise<SensingConfig> =>
    ipcRenderer.invoke('sensing:update-config', partial),
  startCalibration: (durationMs?: number): Promise<boolean> =>
    ipcRenderer.invoke('sensing:start-calibration', durationMs),
  ingestSerialLine: (line: string): Promise<boolean> =>
    ipcRenderer.invoke('sensing:ingest-serial-line', line),
  setSerialStatus: (
    connected: boolean,
    detail: string,
    error?: string
  ): Promise<boolean> =>
    ipcRenderer.invoke('sensing:set-serial-status', connected, detail, error),
  exportSession: (
    format: 'csv' | 'json',
    payload: SessionExportPayload
  ): Promise<{ canceled: boolean; filePath?: string }> =>
    ipcRenderer.invoke('sensing:export-session', format, payload),

  onSample: (cb: (packet: SamplePacket) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: SamplePacket) => cb(data);
    ipcRenderer.on('sensing:sample', handler);
    return () => ipcRenderer.removeListener('sensing:sample', handler);
  },
  onStatus: (cb: (status: SourceStatus) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: SourceStatus) => cb(data);
    ipcRenderer.on('sensing:status', handler);
    return () => ipcRenderer.removeListener('sensing:status', handler);
  },
  onCalibration: (cb: (profile: CalibrationProfile) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: CalibrationProfile) =>
      cb(data);
    ipcRenderer.on('sensing:calibration', handler);
    return () => ipcRenderer.removeListener('sensing:calibration', handler);
  },
  onEvent: (cb: (event: DetectionEvent) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: DetectionEvent) => cb(data);
    ipcRenderer.on('sensing:event', handler);
    return () => ipcRenderer.removeListener('sensing:event', handler);
  },
  onNetworkInfo: (cb: (info: NetworkEnvironmentInfo) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: NetworkEnvironmentInfo) => cb(data);
    ipcRenderer.on('sensing:network-info', handler);
    return () => ipcRenderer.removeListener('sensing:network-info', handler);
  },
};

contextBridge.exposeInMainWorld('wifiSensing', sensingApi);

export type WifiSensingApi = typeof sensingApi;
