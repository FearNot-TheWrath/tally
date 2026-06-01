// Drifting dim clock used during sleep mode.
// Repositions every 60s with a 3s ease transition to defeat burn-in.

function pad(n) { return String(n).padStart(2, '0'); }

function pickPosition() {
  // Stay no closer than 15% to any edge.
  const x = 15 + Math.floor(Math.random() * 70); // 15..85
  const y = 15 + Math.floor(Math.random() * 70);
  return { x, y };
}

function renderAnalogSVG(showNumerals) {
  // Static SVG markup; hands are rotated via inline transforms updated each tick.
  const ticks = Array.from({length: 12}, (_, i) => {
    const angle = i * 30;
    return `<line x1="50" y1="6" x2="50" y2="12" stroke="currentColor" stroke-width="1.2" transform="rotate(${angle} 50 50)" />`;
  }).join('');
  const numerals = showNumerals ? `
    <text x="50" y="16" text-anchor="middle" font-size="9" fill="currentColor">12</text>
    <text x="86" y="53" text-anchor="middle" font-size="9" fill="currentColor">3</text>
    <text x="50" y="90" text-anchor="middle" font-size="9" fill="currentColor">6</text>
    <text x="14" y="53" text-anchor="middle" font-size="9" fill="currentColor">9</text>
  ` : '';
  return `
    <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%">
      <circle cx="50" cy="50" r="48" fill="none" stroke="currentColor" stroke-width="0.6" />
      ${ticks}
      ${numerals}
      <line class="hand-hour"   x1="50" y1="50" x2="50" y2="28" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" transform="rotate(0 50 50)" />
      <line class="hand-minute" x1="50" y1="50" x2="50" y2="18" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" transform="rotate(0 50 50)" />
      <circle cx="50" cy="50" r="1.5" fill="currentColor" />
    </svg>
  `;
}

export class SleepClock {
  constructor(hostEl, style = 'analog-minimal') {
    this.host = hostEl;
    this.style = style;
    this.faceEl = null;
    this.tick = null;
    this.driftTimer = null;
  }

  mount() {
    this.host.hidden = false;
    this.host.innerHTML = '';
    this.faceEl = document.createElement('div');
    this.faceEl.className = 'sleep-face ' + (this.style === 'digital' ? 'digital' : 'analog');
    if (this.style === 'digital') {
      this.faceEl.textContent = this._currentDigital();
    } else {
      this.faceEl.innerHTML = renderAnalogSVG(this.style === 'analog-classic');
    }
    this.host.appendChild(this.faceEl);
    this._reposition();
    this.tick = setInterval(() => this._refresh(), 1000);
    this.driftTimer = setInterval(() => this._reposition(), 60_000);
  }

  unmount() {
    if (this.tick) clearInterval(this.tick);
    if (this.driftTimer) clearInterval(this.driftTimer);
    this.tick = null; this.driftTimer = null;
    this.host.innerHTML = '';
    this.host.hidden = true;
  }

  _currentDigital() {
    const d = new Date();
    const h = d.getHours() % 12 || 12;
    return `${h}:${pad(d.getMinutes())}`;
  }

  _refresh() {
    if (this.style === 'digital') {
      this.faceEl.textContent = this._currentDigital();
      return;
    }
    const d = new Date();
    const minutes = d.getMinutes();
    const hours = d.getHours() % 12 + minutes / 60;
    const hourAngle = hours * 30;       // 360 / 12
    const minuteAngle = minutes * 6;    // 360 / 60
    const hourHand   = this.faceEl.querySelector('.hand-hour');
    const minuteHand = this.faceEl.querySelector('.hand-minute');
    if (hourHand)   hourHand.setAttribute('transform',   `rotate(${hourAngle} 50 50)`);
    if (minuteHand) minuteHand.setAttribute('transform', `rotate(${minuteAngle} 50 50)`);
  }

  _reposition() {
    const { x, y } = pickPosition();
    this.faceEl.style.left = `${x}%`;
    this.faceEl.style.top  = `${y}%`;
    this.faceEl.style.transform = 'translate(-50%, -50%)';
  }
}
