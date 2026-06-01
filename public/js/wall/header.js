// Persistent header for the Wall Suite.
// Updates clock every second; date and streak leader come from wall data on each refresh.

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function fmtTime(d) {
  const h = d.getHours() % 12 || 12;
  const m = String(d.getMinutes()).padStart(2, '0');
  const ampm = d.getHours() < 12 ? 'AM' : 'PM';
  return `${h}:${m} ${ampm}`;
}

function fmtDate(d) {
  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

export class Header {
  constructor(hostEl) {
    this.host = hostEl;
    this.clockEl = null;
    this.dateEl = null;
    this.leaderEl = null;
    this.tick = null;
  }

  mount() {
    this.host.innerHTML = `
      <span class="clock"></span>
      <span class="date"></span>
      <span class="leader" hidden><span class="dot"></span><span class="text"></span></span>
    `;
    this.clockEl  = this.host.querySelector('.clock');
    this.dateEl   = this.host.querySelector('.date');
    this.leaderEl = this.host.querySelector('.leader');
    this._refreshClock();
    this.tick = setInterval(() => this._refreshClock(), 1000);
  }

  unmount() {
    if (this.tick) clearInterval(this.tick);
    this.tick = null;
    this.host.innerHTML = '';
  }

  // streak: { name, color, streak_days } | null
  setStreakLeader(streak) {
    if (!streak) { this.leaderEl.hidden = true; return; }
    this.leaderEl.hidden = false;
    this.leaderEl.querySelector('.dot').style.background = streak.color || '#22C55E';
    this.leaderEl.querySelector('.text').textContent = `${streak.name} · ${streak.streak_days}d streak`;
  }

  hide()  { this.host.hidden = true; }
  show()  { this.host.hidden = false; }

  _refreshClock() {
    const now = new Date();
    this.clockEl.textContent = fmtTime(now);
    this.dateEl.textContent  = fmtDate(now);
  }
}
