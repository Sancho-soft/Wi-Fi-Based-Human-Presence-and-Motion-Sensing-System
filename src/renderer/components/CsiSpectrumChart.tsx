import React, { useEffect, useRef } from 'react';
import { ProcessedSample } from '../../shared/types';

interface CsiSpectrumChartProps {
  samples: ProcessedSample[];
}

function heatColor(norm: number): string {
  const n = Math.max(0, Math.min(1, norm));
  if (n < 0.5) {
    const t = n / 0.5;
    return `rgb(${Math.round(219 - t * 185)}, ${Math.round(234 - t * 100)}, ${Math.round(254 - t * 60)})`;
  }
  const t = (n - 0.5) / 0.5;
  return `rgb(${Math.round(34 + t * 165)}, ${Math.round(134 - t * 90)}, ${Math.round(194 - t * 155)})`;
}

export const CsiSpectrumChart: React.FC<CsiSpectrumChartProps> = ({ samples }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(240, Math.floor(rect.width));
    const height = Math.max(140, Math.floor(rect.height));

    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const csiSamples = samples.filter((s) => s.csiAmplitudes && s.csiAmplitudes.length > 0);
    if (csiSamples.length === 0) {
      ctx.strokeStyle = '#e2e8f0';
      ctx.strokeRect(8, 8, width - 16, height - 16);
      ctx.fillStyle = '#64748b';
      ctx.font = '12px Segoe UI, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(
        'No OFDM subcarrier CSI vector in the active stream (CSI requires ESP32 UDP or USB Serial hardware; scalar RSSI/RTT only on Windows/Modem).',
        width / 2,
        height / 2
      );
      ctx.restore();
      return;
    }

    const latest = csiSamples[csiSamples.length - 1].csiAmplitudes;
    const subCount = latest.length;

    const padL = 38;
    const padR = 12;
    const padT = 10;
    const splitY = Math.floor(height * 0.45);
    const gap = 14;
    const specTop = splitY + gap;
    const specH = height - specTop - 20;
    const plotW = width - padL - padR;

    let maxAmp = 35;
    for (const s of csiSamples.slice(-40)) {
      for (const v of s.csiAmplitudes) {
        if (v > maxAmp) maxAmp = v;
      }
    }

    const barW = plotW / subCount;
    ctx.font = '10px Cascadia Mono, Consolas, monospace';
    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'right';
    ctx.fillText('Amp', padL - 6, padT + 10);

    latest.forEach((amp, i) => {
      const norm = Math.max(0, Math.min(1, amp / maxAmp));
      const bh = norm * (splitY - padT - 4);
      const x = padL + i * barW + 1;
      const y = splitY - bh;
      ctx.fillStyle = '#0369a1';
      ctx.fillRect(x, y, Math.max(2, barW - 2), bh);
    });

    const cols = Math.min(csiSamples.length, 90);
    const slice = csiSamples.slice(-cols);
    const cellW = plotW / Math.max(1, cols);
    const cellH = specH / subCount;

    for (let t = 0; t < slice.length; t++) {
      const vec = slice[t].csiAmplitudes;
      for (let k = 0; k < subCount; k++) {
        const norm = (vec[k] ?? 0) / maxAmp;
        ctx.fillStyle = heatColor(norm);
        ctx.fillRect(
          padL + t * cellW,
          specTop + (subCount - 1 - k) * cellH,
          Math.ceil(cellW + 0.5),
          Math.ceil(cellH + 0.5)
        );
      }
    }

    ctx.strokeStyle = '#cbd5e1';
    ctx.strokeRect(padL, specTop, plotW, specH);

    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'right';
    ctx.fillText(`SC${subCount}`, padL - 6, specTop + 10);
    ctx.fillText('SC1', padL - 6, specTop + specH);

    ctx.textAlign = 'left';
    ctx.fillStyle = '#475569';
    ctx.fillText('OFDM Subcarrier Waterfall (Time →)', padL, height - 5);

    ctx.restore();
  }, [samples]);

  return (
    <div className="chart-canvas-wrap tall">
      <canvas ref={canvasRef} className="chart-canvas" />
    </div>
  );
};
