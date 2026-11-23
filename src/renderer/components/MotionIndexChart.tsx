import React, { useEffect, useRef } from 'react';
import { ProcessedSample } from '../../shared/types';

interface MotionIndexChartProps {
  samples: ProcessedSample[];
  presenceThreshold: number;
  motionThreshold: number;
}

export const MotionIndexChart: React.FC<MotionIndexChartProps> = ({
  samples,
  presenceThreshold,
  motionThreshold,
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

    const padL = 38;
    const padR = 14;
    const padT = 14;
    const padB = 24;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;

    const toY = (val: number) =>
      padT + ((100 - Math.max(0, Math.min(100, val))) / 100) * plotH;

    // Grid
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 1;
    ctx.font = '11px Cascadia Mono, Consolas, monospace';
    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'right';

    for (const tick of [0, 25, 50, 75, 100]) {
      const y = toY(tick);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(width - padR, y);
      ctx.stroke();
      ctx.fillText(`${tick}`, padL - 6, y + 4);
    }

    ctx.strokeStyle = '#cbd5e1';
    ctx.strokeRect(padL, padT, plotW, plotH);

    // Threshold lines
    const drawThreshold = (val: number, color: string, label: string) => {
      const y = toY(val);
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(width - padR, y);
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.textAlign = 'right';
      ctx.fillText(label, width - padR - 4, y - 4);
      ctx.restore();
    };

    drawThreshold(presenceThreshold, '#b45309', `Presence (${presenceThreshold})`);
    drawThreshold(motionThreshold, '#b91c1c', `Motion (${motionThreshold})`);

    if (samples.length >= 2) {
      const stepX = plotW / Math.max(1, samples.length - 1);

      for (let i = 1; i < samples.length; i++) {
        const prev = samples[i - 1];
        const curr = samples[i];
        ctx.strokeStyle =
          curr.presenceState === 'MOTION'
            ? '#b91c1c'
            : curr.presenceState === 'PRESENCE'
              ? '#b45309'
              : '#15803d';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(padL + (i - 1) * stepX, toY(prev.motionIndex));
        ctx.lineTo(padL + i * stepX, toY(curr.motionIndex));
        ctx.stroke();
      }
    } else if (samples.length === 0) {
      ctx.fillStyle = '#64748b';
      ctx.font = '12px Segoe UI, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No motion samples recorded', width / 2, height / 2);
    }

    ctx.font = '11px Cascadia Mono, Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#15803d';
    ctx.fillText('■ Empty', padL + 6, height - 6);
    ctx.fillStyle = '#b45309';
    ctx.fillText('■ Presence', padL + 72, height - 6);
    ctx.fillStyle = '#b91c1c';
    ctx.fillText('■ Motion', padL + 152, height - 6);

    ctx.restore();
  }, [samples, presenceThreshold, motionThreshold]);

  return (
    <div className="chart-canvas-wrap">
      <canvas ref={canvasRef} className="chart-canvas" />
    </div>
  );
};
