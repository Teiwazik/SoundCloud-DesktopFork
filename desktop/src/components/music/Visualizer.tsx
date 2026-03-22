import { listen } from '@tauri-apps/api/event';
import React, { useEffect, useRef } from 'react';
import { useSettingsStore } from '../../stores/settings';

export type VisualizerStyle = 'Off' | 'Bars' | 'Wave' | 'Pulse';

interface VisualizerProps {
  className?: string;
  style?: VisualizerStyle;
}

// Parse hex to RGB to allow alpha blending on canvas
function hexToRgb(hex: string) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? { r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16) }
    : { r: 255, g: 255, b: 255 };
}

export const Visualizer: React.FC<VisualizerProps> = ({ className = '', style }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  // Use passed style or subscribe directly to global settings
  const storeStyle = useSettingsStore((s) => s.visualizerStyle);
  const currentStyle = style || storeStyle || 'Off';

  const themeColorOpt = useSettingsStore((s) => s.visualizerThemeColor);
  const accentColorHex = useSettingsStore((s) => s.accentColor);
  const vizScale = useSettingsStore((s) => s.visualizerScale) / 100;
  const vizXOffset = useSettingsStore((s) => s.visualizerXOffset);
  const vizYOffset = useSettingsStore((s) => s.visualizerYOffset);

  // We capture the base Color outside of the drawing loop so it updates dynamically
  const baseRgb = useRef(hexToRgb('#ffffff'));
  useEffect(() => {
    baseRgb.current = themeColorOpt ? hexToRgb(accentColorHex) : hexToRgb('#ffffff');
  }, [themeColorOpt, accentColorHex]);

  useEffect(() => {
    if (currentStyle === 'Off') return;

    let unlisten: (() => void) | null = null;
    let animationFrameId: number;

    // We store the latest bins here so the render loop can interpolate/smooth them
    let targetBins = new Uint8Array(64);
    const currentBins = new Array(64).fill(0);

    const setup = async () => {
      unlisten = await listen<number[]>('audio:visualizer', (event) => {
        // payload comes as Array of numbers from Rust Vec<u8>
        targetBins = new Uint8Array(event.payload);
      });
    };
    setup();

    const draw = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (canvas.width !== width * window.devicePixelRatio) {
        canvas.width = width * window.devicePixelRatio;
        canvas.height = height * window.devicePixelRatio;
        ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
      }

      ctx.clearRect(0, 0, width, height);

      // Smooth out the array
      for (let i = 0; i < 64; i++) {
        const t = targetBins[i] || 0;
        currentBins[i] += (t - currentBins[i]) * 0.3;
      }

      if (currentStyle === 'Bars') {
        const barWidth = width / 64;
        const gap = Math.max(1, barWidth * 0.2);
        const activeWidth = barWidth - gap;
        const { r, g, b } = baseRgb.current;

        for (let i = 0; i < 64; i++) {
          const val = currentBins[i];
          const h = (val / 255) * height;
          
          ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${Math.max(0.1, val / 255)})`;
          const x = i * barWidth;
          const y = height - h;
          
          ctx.beginPath();
          ctx.roundRect(x, y, activeWidth, h, [4, 4, 0, 0]);
          ctx.fill();
        }
      } else if (currentStyle === 'Wave') {
        ctx.beginPath();
        ctx.moveTo(0, height);
        
        for (let i = 0; i < 64; i++) {
          const val = currentBins[i];
          const h = (val / 255) * height;
          const x = (i / 63) * width;
          const y = height - h;
          
          if (i === 0) ctx.lineTo(x, y);
          else {
            const prevX = ((i - 1) / 63) * width;
            const prevH = (currentBins[i - 1] / 255) * height;
            const prevY = height - prevH;
            
            const cpX = prevX + (x - prevX) / 2;
            ctx.bezierCurveTo(cpX, prevY, cpX, y, x, y);
          }
        }
        
        ctx.lineTo(width, height);
        const { r, g, b } = baseRgb.current;
        const gradient = ctx.createLinearGradient(0, 0, 0, height);
        gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.5)`);
        gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0.0)`);
        ctx.fillStyle = gradient;
        ctx.fill();
        
        ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.9)`;
        ctx.lineWidth = 2;
        ctx.stroke();
      } else if (currentStyle === 'Pulse') {
        const centerX = width / 2;
        const centerY = height / 2;
        let sum = 0;
        for (let i = 0; i < 16; i++) sum += currentBins[i];
        
        const avgBass = sum / 16;
        const radius = Math.min(width, height) * 0.2 + (avgBass / 255) * Math.min(width, height) * 0.3;
        
        ctx.beginPath();
        ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
        
        const { r, g, b } = baseRgb.current;
        const gradient = ctx.createRadialGradient(centerX, centerY, radius * 0.5, centerX, centerY, radius * 1.5);
        gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.8)`);
        gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0.0)`);
        
        ctx.fillStyle = gradient;
        ctx.fill();
      }

      animationFrameId = requestAnimationFrame(draw);
    };

    draw();

    return () => {
      if (unlisten) unlisten();
      cancelAnimationFrame(animationFrameId);
    };
  }, [currentStyle]);

  if (currentStyle === 'Off') return null;

  return (
    <canvas
      ref={canvasRef}
      className={`pointer-events-none ${className}`}
      style={{
        transform: `translate(${vizXOffset}px, ${vizYOffset}px) scale(${vizScale})`,
        transformOrigin: "bottom center",
        transition: "transform 0.15s ease-out"
      }}
    />
  );
};
