import {
  CalibrationProfile,
  MetricMode,
  PresenceState,
  ProcessedSample,
  RawTelemetryFrame,
  SensingConfig,
} from './types';

export const DEFAULT_SENSING_CONFIG: SensingConfig = {
  windowSize: 24,
  emaAlpha: 0.25,
  presenceThreshold: 18,
  motionThreshold: 48,
  hysteresisMs: 900,
  udpPort: 5566,
  serialBaudRate: 115200,
  pingTarget: 'auto',
  lanPollMs: 350,
};

export const DEFAULT_CALIBRATION: CalibrationProfile = {
  isCalibrated: false,
  baselineRssi: -52,
  baselineRttMs: 2.0,
  baselineStd: 0.65,
  baselineCsiStd: 1.1,
  calibratedAt: null,
  sampleCount: 0,
};

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((acc, v) => acc + v, 0) / values.length;
}

function varianceOf(values: number[], avg?: number): number {
  if (values.length < 2) return 0;
  const m = avg ?? mean(values);
  let sumSq = 0;
  for (const v of values) {
    const d = v - m;
    sumSq += d * d;
  }
  return sumSq / values.length;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Real-time telemetry signal processor.
 * Combines Hampel spike rejection, EMA smoothing, sliding-window variance,
 * CSI subcarrier turbulence analysis, RTT jitter fallback, and hysteresis state classification.
 */
export class SignalProcessor {
  private config: SensingConfig;
  private calibration: CalibrationProfile;

  private rawWindow: number[] = [];
  private cleanWindow: number[] = [];
  private csiHistory: number[][] = [];
  private filteredPrimary: number | null = null;
  private activeMode: MetricMode | null = null;
  private smoothedMotionIndex = 0;

  private currentState: PresenceState = 'EMPTY';
  private pendingState: PresenceState | null = null;
  private pendingSince = 0;

  private calibrating = false;
  private calibrationValues: number[] = [];
  private calibrationMode: MetricMode = 'rssi';
  private calibrationCsiHistory: number[][] = [];

  constructor(
    config: Partial<SensingConfig> = {},
    calibration: CalibrationProfile = { ...DEFAULT_CALIBRATION }
  ) {
    this.config = { ...DEFAULT_SENSING_CONFIG, ...config };
    this.calibration = { ...calibration };
  }

  public updateConfig(next: Partial<SensingConfig>): void {
    this.config = { ...this.config, ...next };
  }

  public getConfig(): SensingConfig {
    return { ...this.config };
  }

  public getCalibration(): CalibrationProfile {
    return { ...this.calibration };
  }

  public setCalibration(profile: CalibrationProfile): void {
    this.calibration = { ...profile };
  }

  public startCalibration(): void {
    this.calibrating = true;
    this.calibrationValues = [];
    this.calibrationCsiHistory = [];
  }

  public isCalibrating(): boolean {
    return this.calibrating;
  }

  public getCalibrationSampleCount(): number {
    return this.calibrationValues.length;
  }

  public finishCalibration(): CalibrationProfile {
    this.calibrating = false;
    if (this.calibrationValues.length >= 4) {
      const basePrimary = mean(this.calibrationValues);
      const minStd = this.calibrationMode === 'rtt' ? 0.2 : 0.25;
      const std = Math.max(minStd, Math.sqrt(varianceOf(this.calibrationValues, basePrimary)));
      const csiStd = Math.max(
        0.35,
        this.computeCsiTurbulence(this.calibrationCsiHistory) || 0.85
      );

      this.calibration = {
        ...this.calibration,
        isCalibrated: true,
        baselineRssi:
          this.calibrationMode === 'rtt'
            ? this.calibration.baselineRssi
            : Number(basePrimary.toFixed(2)),
        baselineRttMs:
          this.calibrationMode === 'rtt'
            ? Number(basePrimary.toFixed(2))
            : this.calibration.baselineRttMs,
        baselineStd: Number(std.toFixed(3)),
        baselineCsiStd: Number(csiStd.toFixed(3)),
        calibratedAt: Date.now(),
        sampleCount: this.calibrationValues.length,
      };
    }
    return this.getCalibration();
  }

  public reset(): void {
    this.rawWindow = [];
    this.cleanWindow = [];
    this.csiHistory = [];
    this.filteredPrimary = null;
    this.activeMode = null;
    this.smoothedMotionIndex = 0;
    this.currentState = 'EMPTY';
    this.pendingState = null;
    this.pendingSince = 0;
  }

  public process(frame: RawTelemetryFrame): ProcessedSample {
    const winSize = clamp(Math.round(this.config.windowSize), 6, 120);
    const csi = frame.csiAmplitudes ? [...frame.csiAmplitudes] : [];
    const hasRssi = typeof frame.rssi === 'number' && Number.isFinite(frame.rssi);

    const mode: MetricMode = csi.length > 0 ? 'csi' : hasRssi ? 'rssi' : 'rtt';
    if (this.activeMode !== null && this.activeMode !== mode) {
      // Reset sliding windows when switching between dBm and ms units
      this.rawWindow = [];
      this.cleanWindow = [];
      this.filteredPrimary = null;
    }
    this.activeMode = mode;

    const rawPrimary = hasRssi
      ? (frame.rssi as number)
      : typeof frame.rttMs === 'number' && Number.isFinite(frame.rttMs)
        ? frame.rttMs
        : 0;
    const primaryUnit: 'dBm' | 'ms' = mode === 'rtt' ? 'ms' : 'dBm';
    const baselinePrimary =
      mode === 'rtt' ? this.calibration.baselineRttMs : this.calibration.baselineRssi;

    // Collect calibration data if active
    if (this.calibrating) {
      this.calibrationMode = mode;
      this.calibrationValues.push(rawPrimary);
      if (csi.length > 0) {
        this.calibrationCsiHistory.push(csi);
      }
    }

    // 1. Hampel outlier rejection on primary scalar signal
    this.rawWindow.push(rawPrimary);
    if (this.rawWindow.length > winSize) {
      this.rawWindow.shift();
    }

    let cleanPrimary = rawPrimary;
    if (this.rawWindow.length >= 5) {
      const med = median(this.rawWindow);
      const absDevs = this.rawWindow.map((v) => Math.abs(v - med));
      const mad = Math.max(mode === 'rtt' ? 0.25 : 0.35, 1.4826 * median(absDevs));
      if (Math.abs(rawPrimary - med) > 3.2 * mad) {
        cleanPrimary = med;
      }
    }

    this.cleanWindow.push(cleanPrimary);
    if (this.cleanWindow.length > winSize) {
      this.cleanWindow.shift();
    }

    // 2. Exponential Moving Average smoothing
    const alpha = clamp(this.config.emaAlpha, 0.05, 0.95);
    this.filteredPrimary =
      this.filteredPrimary === null
        ? cleanPrimary
        : alpha * cleanPrimary + (1 - alpha) * this.filteredPrimary;

    // 3. Sliding window variance & baseline delta
    const windowMean = mean(this.cleanWindow);
    const signalVariance = varianceOf(this.cleanWindow, windowMean);
    const signalStd = Math.sqrt(signalVariance);
    const baselineDelta = Math.abs(this.filteredPrimary - baselinePrimary);

    // 4. CSI subcarrier turbulence (temporal std averaged across subcarriers)
    if (csi.length > 0) {
      this.csiHistory.push(csi);
      if (this.csiHistory.length > winSize) {
        this.csiHistory.shift();
      }
    } else if (this.csiHistory.length > 0) {
      this.csiHistory = [];
    }

    const csiTurbulence = this.computeCsiTurbulence(this.csiHistory);

    // 5. Normalized Motion Index (0..100)
    let rawMotionIndex: number;
    if (mode === 'csi' && this.csiHistory.length >= 3) {
      const rssiStdRatio = signalStd / Math.max(0.25, this.calibration.baselineStd);
      const deltaRatio = baselineDelta / Math.max(1.2, this.calibration.baselineStd * 2.5);
      const rssiEnergy =
        Math.max(0, (rssiStdRatio - 0.85) * 18) + Math.max(0, (deltaRatio - 0.5) * 14);
      const csiRatio = csiTurbulence / Math.max(0.35, this.calibration.baselineCsiStd);
      const csiEnergy = Math.max(0, (csiRatio - 0.85) * 24);
      rawMotionIndex = clamp(0.68 * csiEnergy + 0.32 * rssiEnergy, 0, 100);
    } else if (mode === 'rssi') {
      const rssiStdRatio = signalStd / Math.max(0.25, this.calibration.baselineStd);
      const deltaRatio = baselineDelta / Math.max(1.2, this.calibration.baselineStd * 2.5);
      const rssiEnergy =
        Math.max(0, (rssiStdRatio - 0.85) * 18) + Math.max(0, (deltaRatio - 0.5) * 14);
      rawMotionIndex = clamp(rssiEnergy * 1.25, 0, 100);
    } else {
      // RTT jitter mode (LAN / Wi-Fi target ping latency)
      const rttStdRatio = signalStd / Math.max(0.3, this.calibration.baselineStd);
      const rttDeltaRatio = baselineDelta / Math.max(1.5, this.calibration.baselineStd * 3.0);
      const lossPenalty = frame.packetLost ? 28 : 0;
      const rttEnergy =
        Math.max(0, (rttStdRatio - 1.1) * 14) +
        Math.max(0, (rttDeltaRatio - 0.7) * 12) +
        lossPenalty;
      rawMotionIndex = clamp(rttEnergy, 0, 100);
    }

    this.smoothedMotionIndex =
      0.35 * rawMotionIndex + 0.65 * this.smoothedMotionIndex;

    // 6. Classify state with hysteresis to prevent flickering
    const candidateState = this.classifyRawState(this.smoothedMotionIndex);
    const resolvedState = this.applyHysteresis(candidateState, frame.timestamp);

    // 7. Compute confidence score (0..100)
    const confidence = this.computeConfidence(resolvedState, this.smoothedMotionIndex);

    return {
      timestamp: frame.timestamp,
      metricMode: mode,
      rawPrimary: Number(rawPrimary.toFixed(2)),
      filteredPrimary: Number(this.filteredPrimary.toFixed(2)),
      baselinePrimary,
      primaryUnit,
      rawRssi: hasRssi ? Number((frame.rssi as number).toFixed(2)) : null,
      filteredRssi: hasRssi ? Number(this.filteredPrimary.toFixed(2)) : null,
      baselineRssi: hasRssi ? this.calibration.baselineRssi : null,
      variance: Number(signalVariance.toFixed(4)),
      csiTurbulence: Number(csiTurbulence.toFixed(3)),
      motionIndex: Number(this.smoothedMotionIndex.toFixed(1)),
      presenceState: resolvedState,
      confidence: Math.round(confidence),
      csiAmplitudes: csi,
      rttMs: frame.rttMs,
      packetLost: frame.packetLost,
    };
  }

  private computeCsiTurbulence(history: number[][]): number {
    if (history.length < 2) return 0;
    const subCount = history[0]?.length ?? 0;
    if (subCount === 0) return 0;

    let stdSum = 0;
    let validSubcarriers = 0;

    for (let s = 0; s < subCount; s++) {
      const col: number[] = [];
      for (let t = 0; t < history.length; t++) {
        const val = history[t][s];
        if (typeof val === 'number' && Number.isFinite(val)) {
          col.push(val);
        }
      }
      if (col.length >= 2) {
        stdSum += Math.sqrt(varianceOf(col));
        validSubcarriers++;
      }
    }

    return validSubcarriers > 0 ? stdSum / validSubcarriers : 0;
  }

  private classifyRawState(motionIndex: number): PresenceState {
    if (motionIndex >= this.config.motionThreshold) {
      return 'MOTION';
    }
    if (motionIndex >= this.config.presenceThreshold) {
      return 'PRESENCE';
    }
    return 'EMPTY';
  }

  private applyHysteresis(candidate: PresenceState, timestamp: number): PresenceState {
    if (candidate === this.currentState) {
      this.pendingState = null;
      return this.currentState;
    }

    if (this.config.hysteresisMs <= 0) {
      this.currentState = candidate;
      this.pendingState = null;
      return this.currentState;
    }

    if (this.pendingState !== candidate) {
      this.pendingState = candidate;
      this.pendingSince = timestamp;
      return this.currentState;
    }

    const requiredHold =
      candidate === 'MOTION'
        ? this.config.hysteresisMs * 0.5
        : candidate === 'EMPTY'
          ? this.config.hysteresisMs * 1.4
          : this.config.hysteresisMs;

    if (timestamp - this.pendingSince >= requiredHold) {
      this.currentState = candidate;
      this.pendingState = null;
    }

    return this.currentState;
  }

  private computeConfidence(state: PresenceState, motionIndex: number): number {
    const pThresh = this.config.presenceThreshold;
    const mThresh = this.config.motionThreshold;

    if (state === 'EMPTY') {
      const margin = clamp((pThresh - motionIndex) / Math.max(1, pThresh), 0, 1);
      return 65 + margin * 34;
    }
    if (state === 'PRESENCE') {
      const span = Math.max(1, mThresh - pThresh);
      const center = pThresh + span * 0.5;
      const distFromEdge = Math.min(
        Math.abs(motionIndex - pThresh),
        Math.abs(mThresh - motionIndex)
      );
      const norm = clamp(distFromEdge / (span * 0.5), 0, 1);
      const bias = motionIndex >= center ? 4 : 0;
      return clamp(68 + norm * 28 + bias, 55, 98);
    }
    const excess = clamp((motionIndex - mThresh) / Math.max(1, 100 - mThresh), 0, 1);
    return 72 + excess * 27;
  }
}

/**
 * Parses an incoming ESP32 CSI line (either JSON or ESP-CSI CSV format).
 * Example CSV: CSI_DATA,12,AA:BB:CC:DD:EE:FF,-49,...,"[12,-4,18,5,...]"
 * Example JSON: {"rssi":-49,"csi":[18.2,19.1,...],"rtt":4.2}
 */
export function parseEsp32CsiLine(
  line: string
): { rssi: number; csiAmplitudes?: number[]; rttMs?: number } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as {
        rssi?: unknown;
        csi?: unknown;
        amplitudes?: unknown;
        rtt?: unknown;
        rttMs?: unknown;
      };
      const rssi = typeof parsed.rssi === 'number' ? parsed.rssi : -55;
      const rawArr = Array.isArray(parsed.amplitudes)
        ? parsed.amplitudes
        : Array.isArray(parsed.csi)
          ? parsed.csi
          : undefined;
      const csiAmplitudes = rawArr
        ? rawArr.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
        : undefined;
      const rttMs =
        typeof parsed.rttMs === 'number'
          ? parsed.rttMs
          : typeof parsed.rtt === 'number'
            ? parsed.rtt
            : undefined;
      return { rssi, csiAmplitudes, rttMs };
    } catch {
      return null;
    }
  }

  if (trimmed.includes('CSI_DATA')) {
    const bracketMatch = trimmed.match(/\[([^\]]+)\]/);
    const parts = trimmed.split(',');
    let rssi = -55;
    for (let i = 1; i < Math.min(parts.length, 8); i++) {
      const num = Number(parts[i]);
      if (Number.isFinite(num) && num <= -10 && num >= -110) {
        rssi = num;
        break;
      }
    }

    if (bracketMatch) {
      const rawNums = bracketMatch[1]
        .split(/[\s,]+/)
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n));

      if (rawNums.length >= 4) {
        const amplitudes: number[] = [];
        if (rawNums.length >= 20 && rawNums.length % 2 === 0) {
          for (let i = 0; i < rawNums.length; i += 2) {
            const im = rawNums[i];
            const re = rawNums[i + 1];
            amplitudes.push(Number(Math.hypot(re, im).toFixed(2)));
          }
        } else {
          amplitudes.push(...rawNums.map((n) => Math.abs(n)));
        }
        return {
          rssi,
          csiAmplitudes: amplitudes.slice(0, 32),
        };
      }
    }

    return { rssi };
  }

  return null;
}
