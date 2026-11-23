export type SensorSourceType = 'windows-wifi' | 'modem-lan' | 'esp32-udp' | 'esp32-serial';

export type SimulatorScenario = 'empty' | 'stationary' | 'walking' | 'auto-cycle';

export type MetricMode = 'csi' | 'rssi' | 'rtt';

export type PresenceState = 'EMPTY' | 'PRESENCE' | 'MOTION';

export interface RawTelemetryFrame {
  timestamp: number;
  source: SensorSourceType;
  rssi?: number;
  rttMs?: number;
  csiAmplitudes?: number[];
  ssid?: string;
  bssid?: string;
  linkQualityPct?: number;
  radioType?: string;
  channel?: string;
  targetIp?: string;
  packetLost?: boolean;
}

export interface ProcessedSample {
  timestamp: number;
  metricMode: MetricMode;
  rawPrimary: number;
  filteredPrimary: number;
  baselinePrimary: number;
  primaryUnit: 'dBm' | 'ms';
  rawRssi: number | null;
  filteredRssi: number | null;
  baselineRssi: number | null;
  variance: number;
  csiTurbulence: number;
  motionIndex: number;
  presenceState: PresenceState;
  confidence: number;
  csiAmplitudes: number[];
  rttMs?: number;
  packetLost?: boolean;
}

export interface CalibrationProfile {
  isCalibrated: boolean;
  baselineRssi: number;
  baselineRttMs: number;
  baselineStd: number;
  baselineCsiStd: number;
  calibratedAt: number | null;
  sampleCount: number;
}

export interface DetectionEvent {
  id: string;
  timestamp: number;
  type: 'STATE_CHANGE' | 'CALIBRATION' | 'CONNECTION' | 'ALERT';
  fromState?: PresenceState;
  toState?: PresenceState;
  message: string;
  motionIndex?: number;
  confidence?: number;
}

export interface SensingConfig {
  windowSize: number;
  emaAlpha: number;
  presenceThreshold: number;
  motionThreshold: number;
  hysteresisMs: number;
  udpPort: number;
  serialBaudRate: number;
  pingTarget: string;
  lanPollMs: number;
}

export interface SourceStatus {
  source: SensorSourceType;
  connected: boolean;
  running: boolean;
  packetRateHz: number;
  detail: string;
  error?: string;
}

export interface LanHostEntry {
  ip: string;
  mac: string;
  type: string;
  isGateway: boolean;
  hostname?: string;
  vendor?: string;
}

export interface WifiNetworkEntry {
  ssid: string;
  bssid: string;
  signalPct: number;
  channel: string;
  radioType: string;
}

export interface NetworkAdapterSummary {
  name: string;
  description: string;
  ipv4?: string;
  mac?: string;
  gateway?: string;
  dhcpServer?: string;
  linkSpeed?: string;
  status?: string;
  isWireless: boolean;
  isPrimary?: boolean;
}

export interface NetworkEnvironmentInfo {
  hasWifiAdapter: boolean;
  wlansvcRunning: boolean;
  wifiStatusDetail: string;
  defaultGateway: string | null;
  gatewayMac?: string | null;
  gatewayVendor?: string | null;
  localIp: string | null;
  primaryAdapter: NetworkAdapterSummary | null;
  adapters: NetworkAdapterSummary[];
  lanHosts: LanHostEntry[];
  nearbyWifiNetworks: WifiNetworkEntry[];
}

export interface SessionExportPayload {
  exportedAt: string;
  source: SensorSourceType;
  calibration: CalibrationProfile;
  config: SensingConfig;
  samples: ProcessedSample[];
  events: DetectionEvent[];
}
