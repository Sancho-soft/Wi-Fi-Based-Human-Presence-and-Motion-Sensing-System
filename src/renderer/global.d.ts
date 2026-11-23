import type { WifiSensingApi } from '../electron/preload';

export interface SerialPortLike {
  open: (options: { baudRate: number }) => Promise<void>;
  close: () => Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
}

declare global {
  interface Window {
    wifiSensing?: WifiSensingApi;
  }

  interface Navigator {
    serial?: {
      requestPort: () => Promise<SerialPortLike>;
    };
  }
}

export {};
