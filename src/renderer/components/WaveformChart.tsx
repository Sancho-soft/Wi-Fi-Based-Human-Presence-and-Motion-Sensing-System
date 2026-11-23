import React, { useEffect, useRef } from 'react';
import { MetricMode, ProcessedSample } from '../../shared/types';

interface WaveformChartProps {
  samples: ProcessedSample[];
  baselineValue: number;
  unit: 'dBm' | 'ms';
  metricMode: MetricMode;
}

export const WaveformChart: React.FC<WaveformChartProps> = ({
  samples,
  baselineValue,
  unit,
  metricMode,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(200, Math.floor(rect.width));
    const height = Math.max(120, Math.floor(rect.height));

    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const padL = 46;
    const padR = 14;
    const padT = 14;
    const padB = 24;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;

    if (samples.length === 0) {
      ctx.strokeStyle = '#e2e8f0';
      ctx.strokeRect(padL, padT, plotW, plotH);
      ctx.fillStyle = '#64748b';
      ctx.font = '12px Segoe UI, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Waiting for live telemetry frames...', width / 2, height / 2);
      ctx.restore();
      return;
    }

    let minVal = baselineValue - (unit === 'ms' ? 2 : 8);
    let maxVal = baselineValue + (unit === 'ms' ? 6 : 8);
    for (const s of samples) {
      if (s.rawPrimary < minVal) minVal = s.rawPrimary - 1;
      if (s.rawPrimary > maxVal) maxVal = s.rawPrimary + 1;
    }
    if (unit === 'ms') {
      minVal = Math.max(0, Math.floor(minVal));
      maxVal = Math.ceil(maxVal);
      if (maxVal - minVal < 4) maxVal = minVal + 4;
    } else {
      minVal = Math.floor(minVal / 2) * 2;
      maxVal = Math.ceil(maxVal / 2) * 2;
      if (maxVal - minVal < 8) {
        minVal -= 4;
        maxVal += 4;
      }
    }

    const toY = (val: number) =>
      padT + ((maxVal - val) / Math.max(0.1, maxVal - minVal)) * plotH;

    // Gridlines
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 1;
    ctx.font = '11px Cascadia Mono, Consolas, monospace';
    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'right';

    const gridSteps = 4;
    for (let i = 0; i <= gridSteps; i++) {
      const val = minVal + ((maxVal - minVal) * i) / gridSteps;
      const y = toY(val);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(width - padR, y);
      ctx.stroke();
      ctx.fillText(unit === 'ms' ? val.toFixed(1) : val.toFixed(0), padL - 6, y + 4);
    }

    // Plot border
    ctx.strokeStyle = '#cbd5e1';
    ctx.strokeRect(padL, padT, plotW, plotH);

    // Baseline dashed line
    const baseY = toY(baselineValue);
    if (baseY >= padT && baseY <= padT + plotH) {
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = '#15803d';
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.moveTo(padL, baseY);
      ctx.lineTo(width - padR, baseY);
      ctx.stroke();
      ctx.restore();
    }

    if (samples.length >= 2) {
      const stepX = plotW / Math.max(1, samples.length - 1);

      // Raw trace
      ctx.strokeStyle = '#94a3b8';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      samples.forEach((s, idx) => {
        const x = padL + idx * stepX;
        const y = toY(s.rawPrimary);
        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();

      // Filtered EMA trace
      ctx.strokeStyle = '#0369a1';
      ctx.lineWidth = 2;
      ctx.beginPath();
      samples.forEach((s, idx) => {
        const x = padL + idx * stepX;
        const y = toY(s.filteredPrimary);
        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();

      const last = samples[samples.length - 1];
      const lx = padL + (samples.length - 1) * stepX;
      const ly = toY(last.filteredPrimary);
      ctx.fillStyle = '#0369a1';
      ctx.beginPath();
      ctx.arc(lx, ly, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.textAlign = 'left';
    ctx.fillStyle = '#475569';
    ctx.fillText(unit, 8, padT + 4);
    ctx.fillStyle = '#0369a1';
    ctx.fillText(`— Filtered (${metricMode.toUpperCase()})`, padL + 6, height - 6);
    ctx.fillStyle = '#64748b';
    ctx.fillText('— Raw', padL + 145, height - 6);
    ctx.fillStyle = '#15803d';
    ctx.fillText('-- Baseline', padL + 205, height - 6);

    ctx.restore();
  }, [samples, baselineValue, unit, metricMode]);

  return (
    <div className="chart-canvas-wrap">
      <canvas ref={canvasRef} className="chart-canvas" />
    </div>
  );
};
