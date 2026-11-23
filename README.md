# Wi-Fi-Based Human Presence & Motion Sensing System

A desktop telemetry and signal-analysis application built with **Electron + React + TypeScript** for device-free human presence and motion detection over Wi-Fi and LAN telemetry.

## Key Features

- **Real Hardware Telemetry Backends**
  - **Modem / LAN Probe (ICMP RTT & ARP Discovery)**: Automatically detects the primary Ethernet/Wi-Fi uplink adapter, identifies the modem/router vendor, discovers active LAN hosts via fast UDP ARP sweeping, and probes real-time ICMP RTT and latency variance.
  - **Windows Native Wi-Fi (RSSI + RTT)**: Polls `netsh wlan show interfaces` signal strength, BSSID scan tables (`netsh wlan show networks mode=bssid`), and gateway ICMP RTT on Wi-Fi-equipped Windows PCs.
  - **ESP32 Wi-Fi CSI over UDP (`port 5566`)**: Receives and parses real-time Espressif `CSI_DATA` CSV frames or JSON telemetry packets over LAN UDP.
  - **ESP32 USB Serial (COM Port)**: Direct Web Serial API streaming from an ESP32 plugged into USB.
- **Digital Signal Processing Pipeline** (`src/shared/signalProcessor.ts`)
  - Hampel outlier spike rejection (`median ± 3.2 * MAD`)
  - Exponential Moving Average (EMA) smoothing
  - Sliding-window variance + CSI subcarrier turbulence extraction + RTT jitter fallback
  - Baseline calibration & hysteresis state machine (`EMPTY` / `PRESENCE` / `MOTION`)
- **Desktop Instrument Interface**
  - Live Signal Waveform chart (Raw vs. Filtered EMA vs. Calibrated Baseline in `dBm` or `ms`)
  - Motion Index timeline with adjustable Presence/Motion thresholds
  - OFDM Subcarrier Spectrum & Time-Frequency Waterfall Spectrogram
  - Hardware & Modem Target selector, Event Log, and CSV/JSON session export

## Getting Started

```bash
npm install
npm run test
npm run dev
```

To build production bundles and start Electron:

```bash
npm run electron:start
```

To package a standalone Windows portable `.exe` (`release/Wi-Fi-Presence-Monitor.exe`):

```bash
npm run package:exe
```
