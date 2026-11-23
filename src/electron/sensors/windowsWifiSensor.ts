import { execFile } from 'child_process';
import { promisify } from 'util';
import { RawTelemetryFrame, WifiNetworkEntry } from '../../shared/types';

const execFileAsync = promisify(execFile);

export interface WindowsWifiReading {
  frame?: RawTelemetryFrame;
  connected: boolean;
  hasAdapter: boolean;
  detail: string;
  error?: string;
}

export function parseNetshInterfacesOutput(output: string): {
  ssid?: string;
  bssid?: string;
  signalPct?: number;
  rssiDbm?: number;
  state?: string;
  radioType?: string;
  channel?: string;
} {
  const lines = output.split(/\r?\n/);
  const result: {
    ssid?: string;
    bssid?: string;
    signalPct?: number;
    rssiDbm?: number;
    state?: string;
    radioType?: string;
    channel?: string;
  } = {};

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim().toLowerCase();
    const val = line.slice(colonIdx + 1).trim();

    if (key === 'state' && !result.state) {
      result.state = val.toLowerCase();
    } else if (key === 'ssid' && !result.ssid) {
      result.ssid = val;
    } else if ((key === 'bssid' || key === 'ap bssid') && !result.bssid) {
      result.bssid = val;
    } else if (key === 'radio type' && !result.radioType) {
      result.radioType = val;
    } else if (key === 'channel' && !result.channel) {
      result.channel = val;
    } else if (key === 'signal' && result.signalPct === undefined) {
      const match = val.match(/(\d+)\s*%/);
      if (match) {
        result.signalPct = Number(match[1]);
      }
    } else if (key === 'rssi' && result.rssiDbm === undefined) {
      const match = val.match(/(-?\d+)/);
      if (match) {
        result.rssiDbm = Number(match[1]);
      }
    }
  }

  return result;
}

export function parseNetshNetworksOutput(output: string): WifiNetworkEntry[] {
  const lines = output.split(/\r?\n/);
  const entries: WifiNetworkEntry[] = [];
  let currentSsid = '';
  let currentBssid = '';
  let currentSignal = 0;
  let currentChannel = '';
  let currentRadio = '';

  const flushBssid = () => {
    if (currentBssid) {
      entries.push({
        ssid: currentSsid || '(Hidden SSID)',
        bssid: currentBssid,
        signalPct: currentSignal,
        channel: currentChannel,
        radioType: currentRadio,
      });
      currentBssid = '';
      currentSignal = 0;
      currentChannel = '';
      currentRadio = '';
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim().toLowerCase();
    const val = line.slice(colonIdx + 1).trim();

    if (/^ssid\s+\d+$/i.test(key)) {
      flushBssid();
      currentSsid = val;
    } else if (/^bssid\s+\d+$/i.test(key)) {
      flushBssid();
      currentBssid = val;
    } else if (key === 'signal') {
      const m = val.match(/(\d+)\s*%/);
      if (m) currentSignal = Number(m[1]);
    } else if (key === 'channel') {
      currentChannel = val;
    } else if (key === 'radio type') {
      currentRadio = val;
    }
  }
  flushBssid();
  return entries.sort((a, b) => b.signalPct - a.signalPct);
}

export function parsePingRttMs(stdout: string): number | undefined {
  const ltMatch = stdout.match(/time\s*<\s*1\s*ms/i);
  if (ltMatch) return 0.5;
  const eqMatch = stdout.match(/time[=]\s*(\d+(?:\.\d+)?)\s*ms/i);
  if (eqMatch) return Number(eqMatch[1]);
  return undefined;
}

export class WindowsWifiSensor {
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private gatewayIp: string | null = null;

  public async detectDefaultGateway(): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('ipconfig', [], { timeout: 2500, windowsHide: true });
      const match = stdout.match(/Default Gateway[^\r\n:]*:\s*([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)/i);
      if (match) {
        this.gatewayIp = match[1];
        return this.gatewayIp;
      }
    } catch {
      // Ignore if ipconfig unavailable
    }
    return null;
  }

  private async measureRtt(host: string): Promise<number | undefined> {
    try {
      const { stdout } = await execFileAsync('ping', ['-n', '1', '-w', '450', host], {
        timeout: 1200,
        windowsHide: true,
      });
      return parsePingRttMs(stdout);
    } catch {
      return undefined;
    }
  }

  public async scanNetworks(): Promise<{
    hasWifiAdapter: boolean;
    wlansvcRunning: boolean;
    detail: string;
    networks: WifiNetworkEntry[];
  }> {
    try {
      const { stdout } = await execFileAsync('netsh', ['wlan', 'show', 'networks', 'mode=bssid'], {
        timeout: 3500,
        windowsHide: true,
      });
      const networks = parseNetshNetworksOutput(stdout);
      return {
        hasWifiAdapter: true,
        wlansvcRunning: true,
        detail: `${networks.length} BSSID(s) visible`,
        networks,
      };
    } catch (err) {
      const msg = extractExecErrorText(err);
      const noService = /wlansvc|not running|command was not found/i.test(msg);
      const noIface = /there is no wireless interface/i.test(msg);
      return {
        hasWifiAdapter: !noService && !noIface,
        wlansvcRunning: !noService,
        detail: noService
          ? 'No Wi-Fi adapter / Wireless AutoConfig Service (wlansvc) stopped'
          : noIface
            ? 'No wireless interface on this PC'
            : msg || 'WLAN scan unavailable',
        networks: [],
      };
    }
  }

  public async pollOnce(pingTarget = 'auto'): Promise<WindowsWifiReading> {
    try {
      const { stdout } = await execFileAsync('netsh', ['wlan', 'show', 'interfaces'], {
        timeout: 2500,
        windowsHide: true,
      });

      if (/there is no wireless interface/i.test(stdout)) {
        return {
          connected: false,
          hasAdapter: false,
          detail: 'No Wi-Fi adapter installed on this PC',
          error: 'Plug in a USB Wi-Fi adapter or use Modem / LAN Probe or ESP32 CSI.',
        };
      }

      const parsed = parseNetshInterfacesOutput(stdout);
      if (!parsed.state || !parsed.state.includes('connected')) {
        return {
          connected: false,
          hasAdapter: true,
          detail: parsed.state
            ? `Wi-Fi adapter state: ${parsed.state}`
            : 'No active Wi-Fi connection found',
        };
      }

      const signalPct = parsed.signalPct ?? 0;
      const rssi =
        typeof parsed.rssiDbm === 'number'
          ? parsed.rssiDbm
          : Math.round(signalPct / 2 - 100);

      let rttMs: number | undefined;
      const host =
        pingTarget === 'auto'
          ? this.gatewayIp ?? (await this.detectDefaultGateway())
          : pingTarget || null;
      if (host) {
        rttMs = await this.measureRtt(host);
      }

      const frame: RawTelemetryFrame = {
        timestamp: Date.now(),
        source: 'windows-wifi',
        rssi,
        rttMs,
        ssid: parsed.ssid || 'Unknown SSID',
        bssid: parsed.bssid || '00:00:00:00:00:00',
        linkQualityPct: signalPct,
        radioType: parsed.radioType,
        channel: parsed.channel,
      };

      return {
        frame,
        connected: true,
        hasAdapter: true,
        detail: `Connected to ${frame.ssid} (${signalPct}% / ${rssi} dBm)`,
      };
    } catch (err) {
      const msg = extractExecErrorText(err);
      const noService = /wlansvc|not running|command was not found/i.test(msg);
      return {
        connected: false,
        hasAdapter: false,
        detail: noService
          ? 'No Wi-Fi adapter active (Windows WLAN AutoConfig service stopped)'
          : 'Windows Wi-Fi interface unavailable',
        error: noService
          ? 'This PC appears to be wired-only (no active Wi-Fi card). Connect a USB Wi-Fi adapter or switch to Modem / LAN Probe or ESP32 CSI.'
          : msg,
      };
    }
  }

  public start(
    intervalMs: number,
    pingTarget: string,
    onReading: (reading: WindowsWifiReading) => void
  ): void {
    this.stop();
    const tick = async () => {
      if (this.polling) return;
      this.polling = true;
      try {
        const reading = await this.pollOnce(pingTarget);
        onReading(reading);
      } finally {
        this.polling = false;
      }
    };
    void tick();
    this.timer = setInterval(() => void tick(), Math.max(250, intervalMs));
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.polling = false;
  }
}

function extractExecErrorText(err: unknown): string {
  if (err && typeof err === 'object') {
    const rec = err as { stdout?: string; stderr?: string; message?: string };
    return [rec.stdout, rec.stderr, rec.message].filter(Boolean).join(' ').trim();
  }
  return String(err);
}
