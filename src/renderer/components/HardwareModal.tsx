import React from 'react';
import { X, Cpu, Wifi, Usb, Network } from 'lucide-react';

interface HardwareModalProps {
  open: boolean;
  udpPort: number;
  localIp: string | null;
  gatewayIp: string | null;
  onClose: () => void;
}

export const HardwareModal: React.FC<HardwareModalProps> = ({
  open,
  udpPort,
  localIp,
  gatewayIp,
  onClose,
}) => {
  if (!open) return null;

  const sampleJson = `{"rssi":-49,"csi":[21.4,22.1,23.8,24.0,22.7,19.9],"rtt":3.8}`;
  const sampleEspCsi = `CSI_DATA,142,AA:BB:CC:DD:EE:FF,-51,11,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,64,"[12,-4,18,5,22,-9,14,11]"`;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="panel-header">
          <h2 className="panel-title" style={{ fontSize: '14px' }}>
            <Cpu size={15} /> Hardware &amp; Modem Connection Reference
          </h2>
          <button className="btn" onClick={onClose}>
            <X size={14} /> Close
          </button>
        </div>

        <div className="controls-stack" style={{ gap: '14px' }}>
          <div>
            <h3 style={{ margin: '0 0 4px', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Network size={14} /> 1. Modem / LAN Probe (ICMP RTT)
            </h3>
            <p style={{ margin: 0, color: '#334155', fontSize: '12px', lineHeight: 1.5 }}>
              Probes your modem gateway (<code className="mono">{gatewayIp ?? 'auto'}</code>) or any
              client IP on your modem&apos;s subnet. Note: if this PC is wired by Ethernet cable to the
              modem, pinging the modem directly measures copper cable latency (&lt;1 ms) and will not
              detect RF room motion. To measure Wi-Fi link variance without a Wi-Fi adapter on this PC,
              select a wireless client (phone/laptop connected to your modem&apos;s Wi-Fi) from the LAN
              Host table.
            </p>
          </div>

          <div>
            <h3 style={{ margin: '0 0 4px', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Wifi size={14} /> 2. Windows Native Wi-Fi (RSSI + RTT)
            </h3>
            <p style={{ margin: 0, color: '#334155', fontSize: '12px', lineHeight: 1.5 }}>
              Reads real 802.11 RSSI / Signal % from your PC&apos;s Wi-Fi adapter via Windows WLAN
              interface (<code className="mono">netsh wlan show interfaces</code>). Requires an active
              built-in or USB Wi-Fi adapter connected to your modem&apos;s SSID.
            </p>
          </div>

          <div>
            <h3 style={{ margin: '0 0 4px', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Cpu size={14} /> 3. ESP32 Wi-Fi CSI over UDP (Port {udpPort})
            </h3>
            <p style={{ margin: '0 0 6px', color: '#334155', fontSize: '12px', lineHeight: 1.5 }}>
              For full multi-subcarrier Channel State Information (CSI), connect an ESP32 / ESP32-S3 to
              your modem&apos;s Wi-Fi and send UDP packets to this PC (<code className="mono">{localIp ?? 'LAN_IP'}:{udpPort}</code>):
            </p>
            <pre className="code-block mono">
{`// Option A: JSON line
${sampleJson}

// Option B: Standard ESP-IDF CSI_DATA CSV line
${sampleEspCsi}`}
            </pre>
          </div>

          <div>
            <h3 style={{ margin: '0 0 4px', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Usb size={14} /> 4. ESP32 USB Serial (COM Port)
            </h3>
            <p style={{ margin: 0, color: '#334155', fontSize: '12px', lineHeight: 1.5 }}>
              Connect an ESP32 to USB, switch to <strong>ESP32 Serial</strong>, choose the baud rate,
              and click <strong>Connect USB Serial</strong>.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
