import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BookOpen,
  Cpu,
  Download,
  Network,
  Pause,
  Play,
  Radio,
  RefreshCw,
  RotateCcw,
  Sliders,
  Trash2,
  Usb,
  UserCheck,
  UserX,
  Waves,
  Wifi,
} from 'lucide-react';
import {
  DEFAULT_CALIBRATION,
  DEFAULT_SENSING_CONFIG,
} from '../shared/signalProcessor';
import {
  CalibrationProfile,
  DetectionEvent,
  NetworkEnvironmentInfo,
  PresenceState,
  ProcessedSample,
  SensingConfig,
  SensorSourceType,
  SourceStatus,
} from '../shared/types';
import { CsiSpectrumChart } from './components/CsiSpectrumChart';
import { HardwareModal } from './components/HardwareModal';
import { MotionIndexChart } from './components/MotionIndexChart';
import { WaveformChart } from './components/WaveformChart';
import type { SerialPortLike } from './global';

const MAX_BUFFER_SAMPLES = 150;
const MAX_EVENTS = 80;

const EMPTY_NETWORK_INFO: NetworkEnvironmentInfo = {
  hasWifiAdapter: false,
  wlansvcRunning: false,
  wifiStatusDetail: 'Checking adapters...',
  defaultGateway: null,
  gatewayMac: null,
  gatewayVendor: null,
  localIp: null,
  primaryAdapter: null,
  adapters: [],
  lanHosts: [],
  nearbyWifiNetworks: [],
};

function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatDwell(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

export const App: React.FC = () => {
  const api = window.wifiSensing;

  const [source, setSource] = useState<SensorSourceType>('modem-lan');
  const [running, setRunning] = useState(true);
  const [config, setConfig] = useState<SensingConfig>(DEFAULT_SENSING_CONFIG);
  const [calibration, setCalibration] = useState<CalibrationProfile>(DEFAULT_CALIBRATION);
  const [calibrating, setCalibrating] = useState(false);
  const [calibrationSamples, setCalibrationSamples] = useState(0);
  const [networkInfo, setNetworkInfo] = useState<NetworkEnvironmentInfo>(EMPTY_NETWORK_INFO);
  const [refreshingNet, setRefreshingNet] = useState(false);

  const [status, setStatus] = useState<SourceStatus>({
    source: 'modem-lan',
    connected: false,
    running: true,
    packetRateHz: 0,
    detail: 'Initializing hardware telemetry...',
  });

  const [samples, setSamples] = useState<ProcessedSample[]>([]);
  const [events, setEvents] = useState<DetectionEvent[]>([]);

  const [linkMeta, setLinkMeta] = useState<{
    ssid?: string;
    bssid?: string;
    linkQualityPct?: number;
    radioType?: string;
    channel?: string;
    targetIp?: string;
  }>({});

  const [customTargetInput, setCustomTargetInput] = useState<string>('auto');
  const [stateChangedAt, setStateChangedAt] = useState<number>(Date.now());
  const [nowTick, setNowTick] = useState<number>(Date.now());
  const [hardwareModalOpen, setHardwareModalOpen] = useState(false);
  const [serialConnected, setSerialConnected] = useState(false);

  const serialPortRef = useRef<SerialPortLike | null>(null);
  const serialReaderAbortRef = useRef(false);
  const lastSampleStateRef = useRef<PresenceState>('EMPTY');

  const appendEvent = useCallback((evt: DetectionEvent) => {
    setEvents((prev) => [evt, ...prev].slice(0, MAX_EVENTS));
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!api) {
      setStatus({
        source: 'windows-wifi',
        connected: false,
        running: false,
        packetRateHz: 0,
        detail: 'Electron runtime required for Windows Wi-Fi, Modem/LAN probe, and UDP CSI',
        error: 'Launch via Electron desktop app (npm run electron:start or npm run dev).',
      });
      return;
    }

    let unsubSample = () => {};
    let unsubStatus = () => {};
    let unsubCal = () => {};
    let unsubEvt = () => {};
    let unsubNet = () => {};

    void api.getInitState().then((init) => {
      setSource(init.source);
      setRunning(init.running);
      setConfig(init.config);
      setCustomTargetInput(init.config.pingTarget);
      setCalibration(init.calibration);
      setStatus(init.status);
      setNetworkInfo(init.networkInfo);
    });

    unsubNet = api.onNetworkInfo((info) => {
      setNetworkInfo(info);
    });

    unsubSample = api.onSample((pkt) => {
      setSamples((prev) => [...prev.slice(-(MAX_BUFFER_SAMPLES - 1)), pkt.sample]);
      setCalibrating(pkt.calibrating);
      setCalibrationSamples(pkt.calibrationSamples);
      setLinkMeta({
        ssid: pkt.ssid,
        bssid: pkt.bssid,
        linkQualityPct: pkt.linkQualityPct,
        radioType: pkt.radioType,
        channel: pkt.channel,
        targetIp: pkt.targetIp,
      });
      if (pkt.sample.presenceState !== lastSampleStateRef.current) {
        lastSampleStateRef.current = pkt.sample.presenceState;
        setStateChangedAt(pkt.sample.timestamp);
      }
    });

    unsubStatus = api.onStatus((nextStatus) => {
      setStatus(nextStatus);
    });

    unsubCal = api.onCalibration((profile) => {
      setCalibration(profile);
      setCalibrating(false);
    });

    unsubEvt = api.onEvent((evt) => {
      appendEvent(evt);
    });

    return () => {
      unsubSample();
      unsubStatus();
      unsubCal();
      unsubEvt();
      unsubNet();
    };
  }, [api, appendEvent]);

  const handleRefreshNetwork = async () => {
    if (!api) return;
    setRefreshingNet(true);
    try {
      const info = await api.getNetworkInfo(true);
      setNetworkInfo(info);
    } finally {
      setRefreshingNet(false);
    }
  };

  const disconnectSerial = useCallback(async () => {
    serialReaderAbortRef.current = true;
    if (serialPortRef.current) {
      try {
        await serialPortRef.current.close();
      } catch {
        // Ignore close errors
      }
      serialPortRef.current = null;
    }
    setSerialConnected(false);
    if (api) {
      await api.setSerialStatus(false, 'USB Serial disconnected');
    }
  }, [api]);

  const connectSerial = useCallback(async () => {
    if (!navigator.serial) {
      appendEvent({
        id: `${Date.now()}`,
        timestamp: Date.now(),
        type: 'ALERT',
        message: 'Web Serial API is unavailable in this runtime',
      });
      return;
    }

    try {
      await disconnectSerial();
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate: config.serialBaudRate });
      serialPortRef.current = port;
      serialReaderAbortRef.current = false;
      setSerialConnected(true);

      if (api) {
        await api.setSerialStatus(
          true,
          `Connected ESP32 USB Serial @ ${config.serialBaudRate} baud`
        );
      }
      appendEvent({
        id: `${Date.now()}`,
        timestamp: Date.now(),
        type: 'CONNECTION',
        message: `USB Serial stream opened at ${config.serialBaudRate} baud`,
      });

      const decoder = new TextDecoder();
      let buffer = '';
      while (port.readable && !serialReaderAbortRef.current) {
        const reader = port.readable.getReader();
        try {
          while (!serialReaderAbortRef.current) {
            const { value, done } = await reader.read();
            if (done) break;
            if (!value) continue;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() ?? '';
            for (const line of lines) {
              if (line.trim() && api) {
                await api.ingestSerialLine(line);
              }
            }
          }
        } finally {
          reader.releaseLock();
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSerialConnected(false);
      if (api) {
        await api.setSerialStatus(false, 'USB Serial connection failed', msg);
      }
      appendEvent({
        id: `${Date.now()}`,
        timestamp: Date.now(),
        type: 'ALERT',
        message: `USB Serial error: ${msg}`,
      });
    }
  }, [api, appendEvent, config.serialBaudRate, disconnectSerial]);

  const handleSourceChange = async (next: SensorSourceType) => {
    if (next !== 'esp32-serial' && serialConnected) {
      await disconnectSerial();
    }
    setSource(next);
    setSamples([]);
    setLinkMeta({});
    if (api) {
      const nextStatus = await api.setSource(next);
      setStatus(nextStatus);
    }
  };

  const handleToggleRunning = async () => {
    const next = !running;
    setRunning(next);
    if (api) {
      await api.setRunning(next);
    }
  };

  const handleConfigPatch = async (patch: Partial<SensingConfig>) => {
    const merged = { ...config, ...patch };
    setConfig(merged);
    if (patch.pingTarget !== undefined) {
      setCustomTargetInput(patch.pingTarget);
    }
    if (api) {
      await api.updateConfig(patch);
    }
  };

  const handleStartCalibration = async () => {
    setCalibrating(true);
    setCalibrationSamples(0);
    if (api) {
      await api.startCalibration(4500);
    }
  };

  const handleExport = async (format: 'csv' | 'json') => {
    if (!api) return;
    await api.exportSession(format, {
      exportedAt: new Date().toISOString(),
      source,
      calibration,
      config,
      samples,
      events,
    });
  };

  const latest = samples[samples.length - 1];
  const hasTelemetry = Boolean(latest);
  const currentState: PresenceState | 'IDLE' = hasTelemetry
    ? latest.presenceState
    : 'IDLE';
  const motionIndex = latest?.motionIndex ?? 0;
  const activeUnit: 'dBm' | 'ms' =
    latest?.primaryUnit ?? (source === 'modem-lan' ? 'ms' : 'dBm');
  const activeMode = latest?.metricMode ?? (source === 'modem-lan' ? 'rtt' : 'rssi');
  const activeBaseline =
    activeUnit === 'ms' ? calibration.baselineRttMs : calibration.baselineRssi;

  const stateMeta = useMemo(() => {
    if (currentState === 'IDLE') {
      return {
        headline: running ? 'Waiting for Telemetry' : 'Capture Stopped',
        sub: status.error || status.detail,
        color: '#475569',
        icon: <Radio size={16} />,
      };
    }
    if (currentState === 'MOTION') {
      return {
        headline: 'Motion Detected',
        sub:
          activeMode === 'csi'
            ? 'Elevated subcarrier turbulence and signal variance'
            : activeMode === 'rtt'
              ? 'Elevated LAN/Wi-Fi RTT jitter or packet delay'
              : 'Elevated RSSI variance above motion threshold',
        color: '#b91c1c',
        icon: <Activity size={16} />,
      };
    }
    if (currentState === 'PRESENCE') {
      return {
        headline: 'Presence / Low Disturbance',
        sub:
          activeMode === 'rtt'
            ? 'Moderate RTT variance above calibrated baseline'
            : 'Signal deviation above empty-room baseline',
        color: '#b45309',
        icon: <UserCheck size={16} />,
      };
    }
    return {
      headline: 'Baseline / Clear',
      sub: 'Measured variance is within calibrated baseline floor',
      color: '#15803d',
      icon: <UserX size={16} />,
    };
  }, [currentState, running, status.error, status.detail, activeMode]);

  const hardwareWarning = useMemo(() => {
    if (source === 'windows-wifi' && !networkInfo.hasWifiAdapter) {
      return `No Wi-Fi adapter detected on this PC (${networkInfo.wifiStatusDetail}). Active interface is wired Ethernet (IP ${networkInfo.localIp ?? 'unknown'}, Gateway/Modem ${networkInfo.defaultGateway ?? 'unknown'}). To sense RF Wi-Fi RSSI directly, attach a USB Wi-Fi adapter, or switch to Modem / LAN Probe or ESP32 CSI.`;
    }
    if (
      source === 'modem-lan' &&
      !networkInfo.hasWifiAdapter &&
      (config.pingTarget === 'auto' || config.pingTarget === networkInfo.defaultGateway)
    ) {
      return `Probing modem gateway ${networkInfo.defaultGateway ?? 'auto'} over wired Ethernet (${networkInfo.localIp ?? 'local'}). Copper Ethernet RTT stays near <1 ms and cannot see RF body motion directly. Select a wireless client IP (phone/laptop on your modem's Wi-Fi) from the LAN Hosts table below, or connect a USB Wi-Fi adapter / ESP32.`;
    }
    return null;
  }, [source, networkInfo, config.pingTarget]);

  const meterColor =
    !hasTelemetry
      ? '#94a3b8'
      : motionIndex >= config.motionThreshold
        ? '#b91c1c'
        : motionIndex >= config.presenceThreshold
          ? '#b45309'
          : '#15803d';

  return (
    <div className="app-shell">
      {/* Toolbar Header */}
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <Radio size={16} />
          </div>
          <div>
            <h1 className="brand-title">Wi-Fi Presence &amp; Motion Monitor</h1>
            <p className="brand-subtitle">
              Real-time WLAN RSSI, Modem/LAN RTT, and ESP32 CSI Telemetry
            </p>
          </div>
        </div>

        <div className="topbar-controls">
          <div className="source-tabs" role="tablist" aria-label="Telemetry Source">
            <button
              className={`source-tab ${source === 'modem-lan' ? 'active' : ''}`}
              onClick={() => void handleSourceChange('modem-lan')}
            >
              <Network size={13} /> Modem / LAN
            </button>
            <button
              className={`source-tab ${source === 'windows-wifi' ? 'active' : ''}`}
              onClick={() => void handleSourceChange('windows-wifi')}
            >
              <Wifi size={13} /> Windows Wi-Fi
            </button>
            <button
              className={`source-tab ${source === 'esp32-udp' ? 'active' : ''}`}
              onClick={() => void handleSourceChange('esp32-udp')}
            >
              <Cpu size={13} /> ESP32 UDP
            </button>
            <button
              className={`source-tab ${source === 'esp32-serial' ? 'active' : ''}`}
              onClick={() => void handleSourceChange('esp32-serial')}
            >
              <Usb size={13} /> ESP32 Serial
            </button>
          </div>

          {source === 'esp32-serial' && (
            <button
              className={`btn ${serialConnected ? 'btn-stop' : 'btn-primary'}`}
              onClick={() => void (serialConnected ? disconnectSerial() : connectSerial())}
            >
              <Usb size={13} />
              {serialConnected ? 'Disconnect COM' : 'Connect USB Serial'}
            </button>
          )}

          <button
            className={`btn ${running ? 'btn-stop' : 'btn-start'}`}
            onClick={() => void handleToggleRunning()}
          >
            {running ? <Pause size={13} /> : <Play size={13} />}
            {running ? 'Stop' : 'Start'}
          </button>

          <button
            className="btn btn-primary"
            disabled={calibrating || !running || !hasTelemetry}
            onClick={() => void handleStartCalibration()}
          >
            <RotateCcw size={13} />
            {calibrating ? `Calibrating (${calibrationSamples})...` : 'Calibrate Baseline'}
          </button>

          <button
            className="btn"
            disabled={refreshingNet}
            onClick={() => void handleRefreshNetwork()}
            title="Re-scan local adapters, ARP LAN table, and WLAN BSSIDs"
          >
            <RefreshCw size={13} /> Scan Network
          </button>

          <button className="btn" disabled={samples.length === 0} onClick={() => void handleExport('csv')}>
            <Download size={13} /> CSV
          </button>
          <button className="btn" disabled={samples.length === 0} onClick={() => void handleExport('json')}>
            <Download size={13} /> JSON
          </button>
          <button className="btn" onClick={() => setHardwareModalOpen(true)}>
            <BookOpen size={13} /> Setup
          </button>
        </div>
      </header>

      {/* Hardware / Link Status Bar */}
      <div className="status-strip">
        <div className="status-left">
          <span
            className={`status-dot ${
              status.error ? 'err' : status.connected && running ? 'ok' : 'warn'
            }`}
          />
          <span>
            <strong className="mono">{status.source.toUpperCase()}:</strong> {status.detail}
            {status.error ? ` — ${status.error}` : ''}
          </span>
        </div>
        <div className="status-meta mono">
          <span>
            Adapter:{' '}
            <strong style={{ color: '#0f172a' }}>
              {networkInfo.primaryAdapter
                ? `${networkInfo.primaryAdapter.name}${networkInfo.primaryAdapter.linkSpeed ? ` (${networkInfo.primaryAdapter.linkSpeed})` : ''}`
                : '—'}
            </strong>
          </span>
          <span>
            Local IP: <strong style={{ color: '#0f172a' }}>{networkInfo.localIp ?? '—'}</strong>
          </span>
          <span>
            Modem:{' '}
            <strong style={{ color: '#0f172a' }}>
              {networkInfo.defaultGateway ?? '—'}
              {networkInfo.gatewayVendor ? ` (${networkInfo.gatewayVendor})` : ''}
            </strong>
          </span>
          <span>
            Rate: <strong style={{ color: '#0369a1' }}>{status.packetRateHz.toFixed(1)} Hz</strong>
          </span>
          <span>
            Baseline:{' '}
            <strong style={{ color: calibration.isCalibrated ? '#15803d' : '#b45309' }}>
              {activeBaseline} {activeUnit} {calibration.isCalibrated ? '(Calibrated)' : '(Default)'}
            </strong>
          </span>
        </div>
      </div>

      {hardwareWarning && (
        <div className="notice-bar">
          <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: '1px' }} />
          <span>{hardwareWarning}</span>
        </div>
      )}

      {/* State & Readout Summary */}
      <section className="hero-grid">
        <div className="panel state-panel">
          <div className="state-top-row">
            <span className={`state-badge ${currentState}`}>
              {stateMeta.icon} {currentState}
            </span>
            <span className="mono" style={{ fontSize: '12px', color: '#475569' }}>
              Confidence: {hasTelemetry ? `${latest.confidence}%` : '—'} · Dwell{' '}
              {hasTelemetry ? formatDwell(nowTick - stateChangedAt) : '—'}
            </span>
          </div>

          <div>
            <h2 className="presence-headline">{stateMeta.headline}</h2>
            <p className="presence-sub">{stateMeta.sub}</p>
          </div>

          <div>
            <div className="motion-meter-track">
              <div
                className="motion-meter-fill"
                style={{
                  width: `${hasTelemetry ? Math.min(100, Math.max(2, motionIndex)) : 0}%`,
                  background: meterColor,
                }}
              />
              <div
                className="motion-meter-marker"
                style={{ left: `${config.presenceThreshold}%` }}
                title={`Presence threshold: ${config.presenceThreshold}`}
              />
              <div
                className="motion-meter-marker"
                style={{ left: `${config.motionThreshold}%` }}
                title={`Motion threshold: ${config.motionThreshold}`}
              />
            </div>
            <div className="motion-meter-meta mono" style={{ marginTop: '5px' }}>
              <span>Motion Index: {hasTelemetry ? `${motionIndex.toFixed(1)} / 100` : '—'}</span>
              <span>
                P ≥ {config.presenceThreshold} · M ≥ {config.motionThreshold}
              </span>
            </div>
          </div>
        </div>

        <div className="kpi-grid">
          <div className="kpi-card">
            <div className="kpi-label">
              <span>{activeUnit === 'ms' ? 'Filtered RTT' : 'Filtered RSSI'}</span>
              <Wifi size={13} />
            </div>
            <div className="kpi-value mono">
              {latest ? `${latest.filteredPrimary.toFixed(1)} ${activeUnit}` : '—'}
            </div>
            <div className="kpi-foot mono">
              Raw: {latest ? `${latest.rawPrimary.toFixed(1)} ${activeUnit}` : '—'} · Δ{' '}
              {latest ? `${(latest.filteredPrimary - activeBaseline).toFixed(1)}` : '—'}
            </div>
          </div>

          <div className="kpi-card">
            <div className="kpi-label">
              <span>Signal Variance (σ²)</span>
              <Activity size={13} />
            </div>
            <div className="kpi-value mono">
              {latest ? latest.variance.toFixed(3) : '—'}
            </div>
            <div className="kpi-foot mono">
              Baseline σ: {calibration.baselineStd.toFixed(2)} {activeUnit}
            </div>
          </div>

          <div className="kpi-card">
            <div className="kpi-label">
              <span>CSI Turbulence</span>
              <Waves size={13} />
            </div>
            <div className="kpi-value mono">
              {latest && latest.csiAmplitudes.length > 0
                ? latest.csiTurbulence.toFixed(2)
                : 'N/A'}
            </div>
            <div className="kpi-foot mono">
              Subcarriers: {latest?.csiAmplitudes.length ?? 0} active
            </div>
          </div>

          <div className="kpi-card">
            <div className="kpi-label">
              <span>Motion Index</span>
              <Radio size={13} />
            </div>
            <div className="kpi-value mono" style={{ color: stateMeta.color }}>
              {latest ? motionIndex.toFixed(1) : '—'}
            </div>
            <div className="kpi-foot mono">
              Mode: {activeMode.toUpperCase()}
            </div>
          </div>

          <div className="kpi-card">
            <div className="kpi-label">
              <span>ICMP Link RTT</span>
              <Network size={13} />
            </div>
            <div className="kpi-value mono">
              {latest?.rttMs !== undefined ? `${latest.rttMs.toFixed(1)} ms` : '—'}
            </div>
            <div className="kpi-foot mono">
              {linkMeta.targetIp
                ? `Target: ${linkMeta.targetIp}`
                : linkMeta.linkQualityPct !== undefined
                  ? `Signal: ${linkMeta.linkQualityPct}%`
                  : linkMeta.ssid ?? '—'}
            </div>
          </div>

          <div className="kpi-card">
            <div className="kpi-label">
              <span>Sample Buffer</span>
              <Sliders size={13} />
            </div>
            <div className="kpi-value mono">
              {samples.length}{' '}
              <span style={{ fontSize: '12px', color: '#64748b' }}>/ {MAX_BUFFER_SAMPLES}</span>
            </div>
            <div className="kpi-foot mono">Window: {config.windowSize} samples</div>
          </div>
        </div>
      </section>

      {/* Real-time Telemetry Plots */}
      <section className="charts-grid">
        <div className="panel">
          <div className="panel-header">
            <h3 className="panel-title">
              <Wifi size={13} />{' '}
              {activeUnit === 'ms'
                ? 'ICMP RTT Waveform (Raw vs. Hampel + EMA)'
                : 'RSSI Amplitude Waveform (Raw vs. Hampel + EMA)'}
            </h3>
            <span className="mono" style={{ fontSize: '11px', color: '#64748b' }}>
              α = {config.emaAlpha}
            </span>
          </div>
          <WaveformChart
            samples={samples}
            baselineValue={activeBaseline}
            unit={activeUnit}
            metricMode={activeMode}
          />
        </div>

        <div className="panel">
          <div className="panel-header">
            <h3 className="panel-title">
              <Activity size={13} /> Motion Index &amp; State Thresholds
            </h3>
            <span className="mono" style={{ fontSize: '11px', color: '#64748b' }}>
              Hysteresis {config.hysteresisMs} ms
            </span>
          </div>
          <MotionIndexChart
            samples={samples}
            presenceThreshold={config.presenceThreshold}
            motionThreshold={config.motionThreshold}
          />
        </div>
      </section>

      {/* CSI Spectrum & Spectrogram */}
      <section className="panel">
        <div className="panel-header">
          <h3 className="panel-title">
            <Waves size={13} /> OFDM CSI Subcarrier Spectrum &amp; Waterfall
          </h3>
          <span className="mono" style={{ fontSize: '11px', color: '#64748b' }}>
            {latest?.csiAmplitudes.length
              ? `${latest.csiAmplitudes.length} Subcarriers Streaming`
              : 'Requires ESP32 CSI Stream'}
          </span>
        </div>
        <CsiSpectrumChart samples={samples} />
      </section>

      {/* Source Configuration / Hardware Discovery / DSP / Event Log */}
      <section className="bottom-grid">
        <div className="panel">
          <div className="panel-header">
            <h3 className="panel-title">
              <Network size={13} /> Hardware &amp; Modem Target
            </h3>
            <span className="mono" style={{ fontSize: '11px', color: '#64748b' }}>
              {networkInfo.adapters.length} active adapter(s)
            </span>
          </div>

          {source === 'modem-lan' && (
            <div className="controls-stack">
              {networkInfo.primaryAdapter && (
                <div
                  className="mono"
                  style={{
                    background: '#f8fafc',
                    border: '1px solid #cbd5e1',
                    borderRadius: '3px',
                    padding: '7px 9px',
                    fontSize: '11.5px',
                    lineHeight: 1.5,
                  }}
                >
                  <div>
                    <strong>{networkInfo.primaryAdapter.name}</strong>:{' '}
                    {networkInfo.primaryAdapter.description}
                    {networkInfo.primaryAdapter.linkSpeed
                      ? ` · ${networkInfo.primaryAdapter.linkSpeed}`
                      : ''}
                  </div>
                  <div style={{ color: '#475569' }}>
                    PC: {networkInfo.primaryAdapter.ipv4 ?? '—'} (
                    {networkInfo.primaryAdapter.mac ?? '—'}) → Modem:{' '}
                    {networkInfo.defaultGateway ?? '—'}
                    {networkInfo.gatewayVendor ? ` [${networkInfo.gatewayVendor}]` : ''}
                    {networkInfo.gatewayMac ? ` (${networkInfo.gatewayMac})` : ''}
                  </div>
                </div>
              )}

              <div className="control-row">
                <div className="control-label-line">
                  <span>Target IP (&apos;auto&apos; = modem {networkInfo.defaultGateway ?? 'gateway'})</span>
                  <span className="mono">{config.lanPollMs} ms poll</span>
                </div>
                <div className="inline-input-row">
                  <input
                    type="text"
                    className="input-field mono"
                    value={customTargetInput}
                    onChange={(e) => setCustomTargetInput(e.target.value)}
                    placeholder="auto or 192.168.1.x"
                  />
                  <button
                    className="btn btn-primary"
                    onClick={() =>
                      void handleConfigPatch({
                        pingTarget: customTargetInput.trim() || 'auto',
                      })
                    }
                  >
                    Apply
                  </button>
                </div>
              </div>

              <div className="control-row">
                <div className="control-label-line">
                  <span>Probe Interval</span>
                  <span className="mono">{config.lanPollMs} ms</span>
                </div>
                <select
                  className="input-field mono"
                  value={config.lanPollMs}
                  onChange={(e) =>
                    void handleConfigPatch({ lanPollMs: Number(e.target.value) })
                  }
                >
                  <option value={250}>250 ms (~4 Hz)</option>
                  <option value={350}>350 ms (~2.8 Hz)</option>
                  <option value={500}>500 ms (2 Hz)</option>
                  <option value={1000}>1000 ms (1 Hz)</option>
                </select>
              </div>

              <div>
                <div className="control-label-line" style={{ marginBottom: '4px' }}>
                  <span>Discovered LAN / Modem Devices (click to probe)</span>
                </div>
                <div className="data-table-wrap">
                  <table className="data-table mono">
                    <thead>
                      <tr>
                        <th>IP Address</th>
                        <th>MAC Address</th>
                        <th>Vendor / Host</th>
                      </tr>
                    </thead>
                    <tbody>
                      {networkInfo.lanHosts.length === 0 ? (
                        <tr>
                          <td colSpan={3} style={{ color: '#64748b' }}>
                            No ARP hosts discovered yet. Click Scan Network.
                          </td>
                        </tr>
                      ) : (
                        networkInfo.lanHosts.map((h) => {
                          const selected =
                            config.pingTarget === h.ip ||
                            (config.pingTarget === 'auto' && h.isGateway);
                          const labelParts = [
                            h.vendor,
                            h.isGateway ? 'Modem Gateway' : h.hostname || h.type,
                          ].filter(Boolean);
                          return (
                            <tr
                              key={h.ip}
                              className={`clickable-row ${selected ? 'selected-row' : ''}`}
                              onClick={() => void handleConfigPatch({ pingTarget: h.ip })}
                            >
                              <td>{h.ip}</td>
                              <td>{h.mac}</td>
                              <td>{labelParts.join(' · ')}</td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {source === 'windows-wifi' && (
            <div className="controls-stack">
              <div className="control-row">
                <div className="control-label-line">
                  <span>Gateway Ping Target (&apos;auto&apos; = default gateway)</span>
                </div>
                <div className="inline-input-row">
                  <input
                    type="text"
                    className="input-field mono"
                    value={customTargetInput}
                    onChange={(e) => setCustomTargetInput(e.target.value)}
                  />
                  <button
                    className="btn btn-primary"
                    onClick={() =>
                      void handleConfigPatch({
                        pingTarget: customTargetInput.trim() || 'auto',
                      })
                    }
                  >
                    Apply
                  </button>
                </div>
              </div>

              <div className="data-table-wrap">
                <table className="data-table mono">
                  <thead>
                    <tr>
                      <th>SSID</th>
                      <th>BSSID</th>
                      <th>Ch</th>
                      <th>Signal</th>
                    </tr>
                  </thead>
                  <tbody>
                    {networkInfo.nearbyWifiNetworks.length === 0 ? (
                      <tr>
                        <td colSpan={4} style={{ color: '#64748b' }}>
                          {networkInfo.wifiStatusDetail}
                        </td>
                      </tr>
                    ) : (
                      networkInfo.nearbyWifiNetworks.map((net) => (
                        <tr key={net.bssid}>
                          <td>{net.ssid}</td>
                          <td>{net.bssid}</td>
                          <td>{net.channel || '—'}</td>
                          <td>{net.signalPct}%</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {source === 'esp32-udp' && (
            <div className="controls-stack">
              <div className="control-row">
                <div className="control-label-line">
                  <span>UDP Listen Port</span>
                  <span className="mono">{config.udpPort}</span>
                </div>
                <input
                  type="number"
                  className="input-field mono"
                  value={config.udpPort}
                  min={1024}
                  max={65535}
                  onChange={(e) =>
                    void handleConfigPatch({ udpPort: Number(e.target.value) || 5566 })
                  }
                />
              </div>
              <p style={{ margin: 0, fontSize: '12px', color: '#475569', lineHeight: 1.5 }}>
                Configure your ESP32 connected to your modem&apos;s Wi-Fi to transmit{' '}
                <code className="mono">CSI_DATA</code> or JSON packets to{' '}
                <code className="mono">
                  {networkInfo.localIp ?? 'THIS_PC_IP'}:{config.udpPort}
                </code>
                .
              </p>
            </div>
          )}

          {source === 'esp32-serial' && (
            <div className="controls-stack">
              <div className="control-row">
                <div className="control-label-line">
                  <span>Serial Baud Rate</span>
                  <span className="mono">{config.serialBaudRate}</span>
                </div>
                <select
                  className="input-field mono"
                  value={config.serialBaudRate}
                  onChange={(e) =>
                    void handleConfigPatch({ serialBaudRate: Number(e.target.value) })
                  }
                >
                  <option value={115200}>115200</option>
                  <option value={230400}>230400</option>
                  <option value={460800}>460800</option>
                  <option value={921600}>921600</option>
                </select>
              </div>
              <p style={{ margin: 0, fontSize: '12px', color: '#475569', lineHeight: 1.5 }}>
                Click <strong>Connect USB Serial</strong> in the toolbar to read ESP-CSI lines
                directly from an attached COM port.
              </p>
            </div>
          )}
        </div>

        {/* DSP & Thresholds */}
        <div className="panel">
          <div className="panel-header">
            <h3 className="panel-title">
              <Sliders size={13} /> DSP Parameters &amp; Thresholds
            </h3>
          </div>
          <div className="controls-stack">
            <div className="control-row">
              <div className="control-label-line">
                <span>Presence Threshold</span>
                <span className="mono" style={{ color: '#b45309', fontWeight: 700 }}>
                  {config.presenceThreshold}
                </span>
              </div>
              <input
                type="range"
                min={5}
                max={60}
                value={config.presenceThreshold}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  void handleConfigPatch({
                    presenceThreshold: Math.min(val, config.motionThreshold - 5),
                  });
                }}
              />
            </div>

            <div className="control-row">
              <div className="control-label-line">
                <span>Motion Threshold</span>
                <span className="mono" style={{ color: '#b91c1c', fontWeight: 700 }}>
                  {config.motionThreshold}
                </span>
              </div>
              <input
                type="range"
                min={20}
                max={90}
                value={config.motionThreshold}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  void handleConfigPatch({
                    motionThreshold: Math.max(val, config.presenceThreshold + 5),
                  });
                }}
              />
            </div>

            <div className="control-row">
              <div className="control-label-line">
                <span>Sliding Window Size</span>
                <span className="mono">{config.windowSize} samples</span>
              </div>
              <input
                type="range"
                min={8}
                max={60}
                value={config.windowSize}
                onChange={(e) =>
                  void handleConfigPatch({ windowSize: Number(e.target.value) })
                }
              />
            </div>

            <div className="control-row">
              <div className="control-label-line">
                <span>EMA Smoothing Factor (α)</span>
                <span className="mono">{config.emaAlpha.toFixed(2)}</span>
              </div>
              <input
                type="range"
                min={0.05}
                max={0.75}
                step={0.05}
                value={config.emaAlpha}
                onChange={(e) =>
                  void handleConfigPatch({ emaAlpha: Number(e.target.value) })
                }
              />
            </div>
          </div>
        </div>

        {/* Event Log */}
        <div className="panel">
          <div className="panel-header">
            <h3 className="panel-title">
              <Activity size={13} /> Event Log
            </h3>
            <button
              className="btn"
              style={{ padding: '3px 7px', fontSize: '11px' }}
              onClick={() => setEvents([])}
            >
              <Trash2 size={11} /> Clear
            </button>
          </div>
          <div className="event-list">
            {events.length === 0 ? (
              <div style={{ color: '#64748b', fontSize: '12px', padding: '10px 0' }}>
                No events recorded yet.
              </div>
            ) : (
              events.map((evt) => (
                <div key={evt.id} className="event-item">
                  <div className="event-msg">
                    {evt.toState && (
                      <span
                        className={`state-badge ${evt.toState}`}
                        style={{ marginRight: '6px', padding: '1px 6px', fontSize: '10px' }}
                      >
                        {evt.toState}
                      </span>
                    )}
                    <span>{evt.message}</span>
                  </div>
                  <span className="event-time mono">{formatClock(evt.timestamp)}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      <HardwareModal
        open={hardwareModalOpen}
        udpPort={config.udpPort}
        localIp={networkInfo.localIp}
        gatewayIp={networkInfo.defaultGateway}
        onClose={() => setHardwareModalOpen(false)}
      />
    </div>
  );
};
