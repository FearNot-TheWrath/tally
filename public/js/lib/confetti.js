const COLORS = ['#22C55E','#3B82F6','#EAB308','#EF4444','#A855F7','#EC4899'];
const MILESTONES = new Set([7, 14, 30, 60, 100]);

export function isMilestone(days) {
  return MILESTONES.has(days) || (days > 100 && days % 100 === 0);
}

export function streakConfetti(dominantColor) {
  fireConfetti({ count: 60, duration: 2000, dominantColor });
}

export function milestoneConfetti(days, dominantColor) {
  fireConfetti({ count: 150, duration: 3500, message: `${days} day streak!`, dominantColor });
}

export function fireConfetti({ count = 60, duration = 2000, message = null, dominantColor = null } = {}) {
  if (typeof document === 'undefined') return;

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:999;';
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  const particles = Array.from({ length: count }, () => {
    const useDominant = dominantColor && Math.random() < 0.4;
    return {
      x: Math.random() * canvas.width,
      y: -(Math.random() * 20),
      r: 4 + Math.random() * 4,
      color: useDominant ? dominantColor : COLORS[Math.floor(Math.random() * COLORS.length)],
      vy: 2 + Math.random() * 3,
      vx: (Math.random() - 0.5) * 3,
      spin: Math.random() * Math.PI * 2,
      spinRate: (Math.random() - 0.5) * 0.2,
    };
  });

  const start = performance.now();
  const fadeStart = duration * 0.8;

  function frame(now) {
    const elapsed = now - start;
    if (elapsed >= duration) {
      canvas.remove();
      return;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const alpha = elapsed > fadeStart ? 1 - (elapsed - fadeStart) / (duration - fadeStart) : 1;

    for (const p of particles) {
      p.vy += 0.08;
      p.y += p.vy;
      p.x += p.vx;
      p.spin += p.spinRate;

      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, p.r, p.r * 0.6, p.spin, 0, Math.PI * 2);
      ctx.fill();
    }

    if (message) {
      const size = Math.min(canvas.width * 0.08, 48);
      ctx.globalAlpha = alpha;
      ctx.font = `800 ${size}px var(--font-ui), system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = 8;
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(message, canvas.width / 2, canvas.height * 0.35);
      ctx.shadowBlur = 0;
    }

    ctx.globalAlpha = 1;
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}
