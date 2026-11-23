import dgram from 'dgram';
import { parseEsp32CsiLine } from '../../shared/signalProcessor';
import { RawTelemetryFrame } from '../../shared/types';

export class Esp32UdpSensor {
  private socket: dgram.Socket | null = null;
  private port = 5566;
  private lastSender = '';

  public start(
    port: number,
    onFrame: (frame: RawTelemetryFrame, sender: string) => void,
    onStatus: (connected: boolean, detail: string, error?: string) => void
  ): void {
    this.stop();
    this.port = port;

    const socket = dgram.createSocket('udp4');
    this.socket = socket;

    socket.on('error', (err) => {
      onStatus(false, `UDP listener error on port ${this.port}`, err.message);
    });

    socket.on('listening', () => {
      const addr = socket.address();
      onStatus(
        true,
        `Listening for ESP32 CSI UDP packets on 0.0.0.0:${addr.port}`
      );
    });

    socket.on('message', (msg, rinfo) => {
      const sender = `${rinfo.address}:${rinfo.port}`;
      if (sender !== this.lastSender) {
        this.lastSender = sender;
        onStatus(true, `Receiving ESP32 CSI stream from ${sender}`);
      }

      const text = msg.toString('utf8');
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        const parsed = parseEsp32CsiLine(line);
        if (!parsed) continue;

        onFrame(
          {
            timestamp: Date.now(),
            source: 'esp32-udp',
            rssi: parsed.rssi,
            rttMs: parsed.rttMs,
            csiAmplitudes: parsed.csiAmplitudes,
            ssid: `ESP32-UDP (${rinfo.address})`,
          },
          sender
        );
      }
    });

    socket.bind(this.port);
  }

  public stop(): void {
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // Ignore close errors
      }
      this.socket = null;
    }
    this.lastSender = '';
  }
}
