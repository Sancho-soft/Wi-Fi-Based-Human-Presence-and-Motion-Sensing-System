import { RawTelemetryFrame, SimulatorScenario } from './types';

function gaussianNoise(stdDev = 1): number {
  const u1 = Math.max(1e-7, Math.random());
  const u2 = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  return z * stdDev;
}

/**
 * Physics-inspired Wi-Fi CSI & RSSI simulator modeling:
 * - Empty room thermal noise floor
 * - Stationary human presence (body attenuation + 0.25 Hz respiratory chest micro-motion)
 * - Active human walking (multipath Doppler scattering + 1.4-2.2 Hz stride modulation)
 */
export class WifiSignalSimulator {
  private scenario: SimulatorScenario = 'auto-cycle';
  private startTime = Date.now();
  private tickCount = 0;
  private readonly subcarrierCount = 30;
  private readonly baseEnvelope: number[];

  constructor(initialScenario: SimulatorScenario = 'auto-cycle') {
    this.scenario = initialScenario;
    // Realistic Wi-Fi OFDM channel frequency-selective fading envelope
    this.baseEnvelope = Array.from({ length: this.subcarrierCount }, (_, i) => {
      const norm = i / this.subcarrierCount;
      return 22 + 7 * Math.sin(norm * Math.PI * 1.35 + 0.4) - 2.5 * Math.cos(norm * Math.PI * 3);
    });
  }

  public setScenario(scenario: SimulatorScenario): void {
    this.scenario = scenario;
  }

  public getScenario(): SimulatorScenario {
    return this.scenario;
  }

  public getEffectivePhase(now = Date.now()): Exclude<SimulatorScenario, 'auto-cycle'> {
    if (this.scenario !== 'auto-cycle') {
      return this.scenario;
    }
    const elapsedSec = ((now - this.startTime) / 1000) % 28;
    if (elapsedSec < 7) return 'empty';
    if (elapsedSec < 15) return 'stationary';
    if (elapsedSec < 23) return 'walking';
    return 'stationary';
  }

  public nextFrame(now = Date.now()): RawTelemetryFrame {
    this.tickCount++;
    const t = (now - this.startTime) / 1000;
    const phase = this.getEffectivePhase(now);

    let baseRssi = -51.5;
    let rssiNoiseStd = 0.45;
    let rssiDrift = 0;
    let csiModAmp = 0.55;
    let csiNoiseStd = 0.5;
    let rttBase = 3.4;

    if (phase === 'stationary') {
      // Human body absorbs ~2.2 dBm and introduces 0.25 Hz (15 breaths/min) modulation
      baseRssi = -53.8;
      rssiNoiseStd = 0.72;
      rssiDrift = 1.05 * Math.sin(2 * Math.PI * 0.26 * t);
      csiModAmp = 2.6;
      csiNoiseStd = 0.75;
      rttBase = 4.1;
    } else if (phase === 'walking') {
      // Moving person causes strong multipath constructive/destructive interference
      baseRssi = -56.2;
      rssiNoiseStd = 1.85;
      rssiDrift =
        3.9 * Math.sin(2 * Math.PI * 1.55 * t) +
        1.8 * Math.cos(2 * Math.PI * 2.3 * t + 0.7);
      csiModAmp = 7.4;
      csiNoiseStd = 1.65;
      rttBase = 6.2;
    }

    const rssi = baseRssi + rssiDrift + gaussianNoise(rssiNoiseStd);

    const csiAmplitudes = this.baseEnvelope.map((baseAmp, idx) => {
      const k = idx / this.subcarrierCount;
      let dynamic = 0;
      if (phase === 'stationary') {
        // Breathing modulates specific Fresnel-zone sensitive subcarriers
        const sensitivity = 0.55 + 0.75 * Math.sin(k * Math.PI * 2.2 + 0.3);
        dynamic = csiModAmp * sensitivity * Math.sin(2 * Math.PI * 0.26 * t + k * 0.9);
      } else if (phase === 'walking') {
        // Walking creates rapid frequency-selective phase & amplitude shifts
        const doppler =
          csiModAmp *
          Math.sin(2 * Math.PI * 1.6 * t + idx * 0.45) *
          (0.7 + 0.35 * Math.cos(2 * Math.PI * 0.85 * t - idx * 0.2));
        dynamic = doppler;
      } else {
        dynamic = 0.35 * Math.sin(2 * Math.PI * 0.1 * t + idx * 0.2);
      }
      return Number(Math.max(2, baseAmp + dynamic + gaussianNoise(csiNoiseStd)).toFixed(2));
    });

    const rttMs = Number(Math.max(1.1, rttBase + Math.abs(gaussianNoise(phase === 'walking' ? 1.8 : 0.4))).toFixed(2));

    return {
      timestamp: now,
      source: 'esp32-udp',
      rssi: Number(rssi.toFixed(2)),
      rttMs,
      csiAmplitudes,
      ssid: 'SIMULATED-WIFI-CSI-5G',
      bssid: '02:00:00:53:49:4D',
      linkQualityPct: Math.round(Math.max(25, Math.min(100, (rssi + 100) * 1.8))),
    };
  }
}
