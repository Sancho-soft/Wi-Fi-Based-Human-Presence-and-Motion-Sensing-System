import { execFile } from 'child_process';
import dgram from 'dgram';
import dns from 'dns/promises';
import http from 'http';
import { promisify } from 'util';
import {
  LanHostEntry,
  NetworkAdapterSummary,
  RawTelemetryFrame,
} from '../../shared/types';
import { parsePingRttMs } from './windowsWifiSensor';

const execFileAsync = promisify(execFile);

export interface ModemLanReading {
  frame?: RawTelemetryFrame;
  connected: boolean;
  targetIp: string | null;
  detail: string;
  error?: string;
}

const OUI_VENDOR_MAP: Record<string, string> = {
  '30-16-9d': 'TP-Link',
  '3c-84-6a': 'TP-Link',
  'c0-25-e9': 'TP-Link',
  '50-c7-bf': 'TP-Link',
  'b0-4e-26': 'TP-Link',
  '98-da-c4': 'TP-Link',
  '14-cc-20': 'TP-Link',
  'ec-08-6b': 'TP-Link',
  'd8-07-b6': 'TP-Link',
  'ac-84-c6': 'TP-Link',
  '74-da-88': 'TP-Link',
  '00-0a-eb': 'TP-Link',
  'e4-d3-32': 'TP-Link',
  'f4-f2-6d': 'TP-Link',
  '60-e3-27': 'TP-Link',
  '18-a6-f7': 'TP-Link',
  '1c-3b-f3': 'TP-Link',
  '84-16-f9': 'TP-Link',
  '54-af-97': 'TP-Link',
  'a8-42-a1': 'TP-Link',
  '78-8c-b5': 'TP-Link',
  'd8-47-32': 'TP-Link',
  'e8-de-27': 'TP-Link',
  '00-e0-4c': 'Realtek',
  'e8-9c-25': 'ASUS / Realtek',
  '18-d6-c7': 'TP-Link',
  'c4-e9-84': 'TP-Link',
  '70-4f-57': 'TP-Link',
  '00-1d-0f': 'TP-Link',
  'bc-46-99': 'TP-Link',
  '6c-5a-b0': 'TP-Link',
  '28-87-ba': 'TP-Link',
  '40-ed-00': 'TP-Link',
  'b4-b0-24': 'Huawei',
  '48-46-fb': 'Huawei',
  '04-9f-ca': 'Huawei',
  'c8-d1-5e': 'Huawei',
  '20-0b-c7': 'Huawei',
  'e0-51-63': 'ZTE',
  '54-22-f8': 'ZTE',
  'dc-9f-db': 'Ubiquiti',
  'f0-9f-c2': 'Ubiquiti',
  '74-83-c2': 'Ubiquiti',
  'b0-be-76': 'TP-Link',
  '04-d4-c4': 'ASUS',
  '2c-fd-a1': 'ASUS',
  '04-92-26': 'ASUS',
  'a0-63-91': 'Netgear',
  'c0-3f-0e': 'Netgear',
  '28-c6-8e': 'Netgear',
  '1c-b7-2c': 'ASUS',
};

export function lookupMacVendor(mac: string | undefined): string | undefined {
  if (!mac) return undefined;
  const normalized = mac.trim().toLowerCase().replace(/:/g, '-');
  const prefix = normalized.slice(0, 8);
  return OUI_VENDOR_MAP[prefix];
}

export function parseIpconfigSummary(stdout: string): {
  adapters: NetworkAdapterSummary[];
  defaultGateway: string | null;
  localIp: string | null;
  primaryAdapter: NetworkAdapterSummary | null;
} {
  const lines = stdout.split(/\r?\n/);
  const adapters: NetworkAdapterSummary[] = [];
  let current: NetworkAdapterSummary | null = null;
  let defaultGateway: string | null = null;
  let localIp: string | null = null;
  let primaryAdapter: NetworkAdapterSummary | null = null;

  for (const raw of lines) {
    if (!raw.startsWith(' ') && raw.trim().endsWith(':')) {
      if (current) adapters.push(current);
      const header = raw.trim().slice(0, -1);
      const isWireless = /wi-?fi|wireless|wlan/i.test(header);
      current = {
        name: header
          .replace(/^Ethernet adapter\s+|^Wireless LAN adapter\s+|^Unknown adapter\s+/i, '')
          .trim(),
        description: header,
        isWireless,
      };
      continue;
    }

    if (!current) continue;
    const trimmed = raw.trim();
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim().toLowerCase();
    const val = trimmed.slice(colonIdx + 1).trim();

    if (key.startsWith('description')) {
      current.description = val;
      if (/wi-?fi|wireless|wlan/i.test(val)) {
        current.isWireless = true;
      }
    } else if (key.startsWith('physical address')) {
      if (/^[0-9a-fA-F-]{11,17}$/.test(val)) {
        current.mac = val.toLowerCase();
      }
    } else if (key.startsWith('ipv4 address')) {
      const m = val.match(/([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)/);
      if (m) current.ipv4 = m[1];
    } else if (key.startsWith('dhcp server')) {
      const m = val.match(/([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)/);
      if (m) current.dhcpServer = m[1];
    } else if (key.startsWith('default gateway')) {
      const m = val.match(/([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)/);
      if (m) {
        current.gateway = m[1];
        current.isPrimary = true;
        if (!defaultGateway) {
          defaultGateway = m[1];
          primaryAdapter = current;
          if (current.ipv4) localIp = current.ipv4;
        }
      }
    }
  }

  if (current) adapters.push(current);

  const activeAdapters = adapters.filter((a) => Boolean(a.ipv4));
  activeAdapters.sort((a, b) => {
    if (Boolean(a.isPrimary) !== Boolean(b.isPrimary)) return a.isPrimary ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  if (!primaryAdapter && activeAdapters.length > 0) {
    primaryAdapter = activeAdapters[0];
  }
  if (!localIp && primaryAdapter?.ipv4) {
    localIp = primaryAdapter.ipv4;
  }

  return {
    adapters: activeAdapters,
    defaultGateway,
    localIp,
    primaryAdapter,
  };
}

export function parseArpTable(
  stdout: string,
  gatewayIp: string | null,
  interfaceIp?: string | null
): LanHostEntry[] {
  const lines = stdout.split(/\r?\n/);
  const seen = new Set<string>();
  const hosts: LanHostEntry[] = [];
  let inTargetSection = !interfaceIp;

  for (const raw of lines) {
    const ifaceMatch = raw.trim().match(/^Interface:\s+([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)/i);
    if (ifaceMatch) {
      inTargetSection = !interfaceIp || ifaceMatch[1] === interfaceIp;
      continue;
    }
    if (!inTargetSection) continue;

    const match = raw
      .trim()
      .match(/^([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)\s+([0-9a-fA-F:-]{11,17})\s+(\S+)/);
    if (!match) continue;
    const [, ip, mac, type] = match;
    if (type.toLowerCase() !== 'dynamic' && ip !== gatewayIp) continue;
    const firstOctet = Number(ip.split('.')[0]);
    if (firstOctet >= 224 || ip.endsWith('.255')) continue;
    if (seen.has(ip)) continue;
    seen.add(ip);
    const normMac = mac.toLowerCase();
    hosts.push({
      ip,
      mac: normMac,
      type: type.toLowerCase(),
      isGateway: ip === gatewayIp,
      vendor: lookupMacVendor(normMac),
    });
  }

  if (gatewayIp && !seen.has(gatewayIp)) {
    hosts.unshift({
      ip: gatewayIp,
      mac: 'gateway',
      type: 'gateway',
      isGateway: true,
    });
  }

  return hosts.sort((a, b) => {
    if (a.isGateway !== b.isGateway) return a.isGateway ? -1 : 1;
    return a.ip.localeCompare(b.ip, undefined, { numeric: true });
  });
}

export class ModemLanSensor {
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private cachedGateway: string | null = null;

  private async queryNetAdapterMeta(): Promise<
    Map<string, { linkSpeed?: string; status?: string; mac?: string }>
  > {
    const map = new Map<string, { linkSpeed?: string; status?: string; mac?: string }>();
    try {
      const { stdout } = await execFileAsync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          'Get-NetAdapter | Select-Object Name, Status, LinkSpeed, MacAddress | ConvertTo-Json -Compress',
        ],
        { timeout: 2500, windowsHide: true }
      );
      const trimmed = stdout.trim();
      if (!trimmed) return map;
      const parsed = JSON.parse(trimmed) as
        | { Name?: string; Status?: string; LinkSpeed?: string; MacAddress?: string }
        | Array<{ Name?: string; Status?: string; LinkSpeed?: string; MacAddress?: string }>;
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of list) {
        if (item.Name) {
          map.set(item.Name.toLowerCase(), {
            status: item.Status,
            linkSpeed: item.LinkSpeed,
            mac: item.MacAddress?.toLowerCase(),
          });
        }
      }
    } catch {
      // Ignore if PowerShell Get-NetAdapter is unavailable
    }
    return map;
  }

  private async detectGatewayHttpVendor(gatewayIp: string): Promise<string | null> {
    return new Promise((resolve) => {
      const req = http.get(`http://${gatewayIp}/`, { timeout: 900 }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => {
          if (chunks.length < 8) chunks.push(d);
        });
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const server = String(res.headers.server ?? '');
          const combined = `${server}\n${body}`;
          if (/tp-link|tplink/i.test(combined)) {
            const titleMatch = body.match(/<title>([^<]{2,60})<\/title>/i);
            resolve(titleMatch ? titleMatch[1].trim() : 'TP-Link');
            return;
          }
          if (/asus/i.test(combined)) return resolve('ASUS');
          if (/netgear/i.test(combined)) return resolve('Netgear');
          if (/huawei/i.test(combined)) return resolve('Huawei');
          if (/zte/i.test(combined)) return resolve('ZTE');
          resolve(null);
        });
      });
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
      req.on('error', () => resolve(null));
    });
  }

  private async sweepSubnetArp(subnetBaseIp: string): Promise<void> {
    const parts = subnetBaseIp.split('.');
    if (parts.length !== 4) return;
    const prefix = `${parts[0]}.${parts[1]}.${parts[2]}`;

    await new Promise<void>((resolve) => {
      const socket = dgram.createSocket('udp4');
      const payload = Buffer.from([0]);
      socket.on('error', () => {
        // Ignore transient socket send errors during subnet ARP trigger
      });

      for (let i = 1; i <= 254; i++) {
        const ip = `${prefix}.${i}`;
        if (ip === subnetBaseIp) continue;
        socket.send(payload, 65534, ip, () => {});
      }

      setTimeout(() => {
        try {
          socket.close();
        } catch {
          // Ignore close error
        }
        resolve();
      }, 450);
    });
  }

  private async resolveHostnames(hosts: LanHostEntry[]): Promise<LanHostEntry[]> {
    return Promise.all(
      hosts.map(async (h) => {
        try {
          const names = await Promise.race([
            dns.reverse(h.ip),
            new Promise<string[]>((resolve) => setTimeout(() => resolve([]), 200)),
          ]);
          return names.length > 0 ? { ...h, hostname: names[0] } : h;
        } catch {
          return h;
        }
      })
    );
  }

  public async inspectNetwork(activeSweep = false): Promise<{
    adapters: NetworkAdapterSummary[];
    primaryAdapter: NetworkAdapterSummary | null;
    defaultGateway: string | null;
    gatewayMac: string | null;
    gatewayVendor: string | null;
    localIp: string | null;
    lanHosts: LanHostEntry[];
  }> {
    let adapters: NetworkAdapterSummary[] = [];
    let defaultGateway: string | null = null;
    let localIp: string | null = null;
    let primaryAdapter: NetworkAdapterSummary | null = null;

    const [ipconfigRes, netAdapterMeta] = await Promise.all([
      execFileAsync('ipconfig', ['/all'], { timeout: 2500, windowsHide: true }).catch(() => null),
      this.queryNetAdapterMeta(),
    ]);

    if (ipconfigRes) {
      const parsed = parseIpconfigSummary(ipconfigRes.stdout);
      adapters = parsed.adapters.map((a) => {
        const extra = netAdapterMeta.get(a.name.toLowerCase());
        return {
          ...a,
          linkSpeed: extra?.linkSpeed,
          status: extra?.status ?? 'Up',
          mac: a.mac ?? extra?.mac,
        };
      });
      defaultGateway = parsed.defaultGateway;
      localIp = parsed.localIp;
      this.cachedGateway = defaultGateway;
      primaryAdapter =
        adapters.find((a) => a.isPrimary) ??
        (adapters.length > 0 ? adapters[0] : null);
    }

    if (activeSweep && (localIp || defaultGateway)) {
      await this.sweepSubnetArp(localIp ?? (defaultGateway as string));
    }

    let lanHosts: LanHostEntry[] = [];
    try {
      const { stdout } = await execFileAsync('arp', ['-a'], { timeout: 2500, windowsHide: true });
      lanHosts = parseArpTable(stdout, defaultGateway, localIp);
      if (activeSweep && lanHosts.length > 0) {
        lanHosts = await this.resolveHostnames(lanHosts);
      }
    } catch {
      if (defaultGateway) {
        lanHosts = [
          {
            ip: defaultGateway,
            mac: 'gateway',
            type: 'gateway',
            isGateway: true,
          },
        ];
      }
    }

    const gwEntry = lanHosts.find((h) => h.isGateway);
    const gatewayMac = gwEntry?.mac && gwEntry.mac !== 'gateway' ? gwEntry.mac : null;
    let gatewayVendor = gwEntry?.vendor ?? lookupMacVendor(gatewayMac ?? undefined) ?? null;
    if (!gatewayVendor && defaultGateway) {
      gatewayVendor = await this.detectGatewayHttpVendor(defaultGateway);
    }
    if (gwEntry && gatewayVendor && !gwEntry.vendor) {
      gwEntry.vendor = gatewayVendor;
    }

    return {
      adapters,
      primaryAdapter,
      defaultGateway,
      gatewayMac,
      gatewayVendor,
      localIp,
      lanHosts,
    };
  }

  public async pollOnce(targetHost = 'auto'): Promise<ModemLanReading> {
    let host = targetHost && targetHost !== 'auto' ? targetHost.trim() : this.cachedGateway;
    if (!host) {
      const netInfo = await this.inspectNetwork(false);
      host = netInfo.defaultGateway;
    }

    if (!host) {
      return {
        connected: false,
        targetIp: null,
        detail: 'No default gateway / modem IP detected',
        error: 'Enter a modem or LAN IP address manually (e.g. 192.168.1.1).',
      };
    }

    try {
      const { stdout } = await execFileAsync('ping', ['-n', '1', '-w', '500', host], {
        timeout: 1500,
        windowsHide: true,
      });
      const rttMs = parsePingRttMs(stdout);
      if (rttMs === undefined) {
        return {
          connected: false,
          targetIp: host,
          detail: `ICMP timeout probing ${host}`,
          frame: {
            timestamp: Date.now(),
            source: 'modem-lan',
            rttMs: 500,
            targetIp: host,
            packetLost: true,
            ssid: `LAN (${host})`,
          },
        };
      }

      const isGateway = host === this.cachedGateway;
      return {
        connected: true,
        targetIp: host,
        detail: `${isGateway ? 'Modem Gateway' : 'LAN Target'} ${host} · RTT ${rttMs.toFixed(1)} ms`,
        frame: {
          timestamp: Date.now(),
          source: 'modem-lan',
          rttMs,
          targetIp: host,
          packetLost: false,
          ssid: `LAN (${host})`,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        connected: false,
        targetIp: host,
        detail: `Probe failed for ${host}`,
        error: msg,
        frame: {
          timestamp: Date.now(),
          source: 'modem-lan',
          rttMs: 500,
          targetIp: host,
          packetLost: true,
          ssid: `LAN (${host})`,
        },
      };
    }
  }

  public start(
    intervalMs: number,
    targetHost: string,
    onReading: (reading: ModemLanReading) => void
  ): void {
    this.stop();
    const tick = async () => {
      if (this.polling) return;
      this.polling = true;
      try {
        const reading = await this.pollOnce(targetHost);
        onReading(reading);
      } finally {
        this.polling = false;
      }
    };
    void tick();
    this.timer = setInterval(() => void tick(), Math.max(200, intervalMs));
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.polling = false;
  }
}
