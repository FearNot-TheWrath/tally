import { Rotation } from '/js/wall/rotation.js';  // resolved at module load time
import { Header } from '/js/wall/header.js';
import { SleepClock } from '/js/wall/sleep-clock.js';
import { isInSleepWindow } from '/js/wall/sleep.js';

import chores  from '/js/wall/panels/chores.js';
import weather from '/js/wall/panels/weather.js';

// Panel registry. Add new panel modules here as Phase 2/3 lands.
const PANEL_REGISTRY = { chores, weather };

function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

export class Stage {
  constructor({ stageEl, headerEl, sleepEl }) {
    this.stageEl = stageEl;
    this.headerEl = headerEl;
    this.sleepEl = sleepEl;
    this.header = new Header(headerEl);
    this.sleepClock = null;

    this.config = null;
    this.rotation = null;
    this.activePanel = null;        // module reference of currently mounted panel
    this.activePanelEl = null;      // its mount host
    this.activeData = null;
    this.dwellTimer = null;
    this.sleepCheckTimer = null;
    this.sleeping = false;

    this.es = null;
    this.sseBackoffMs = 1000;
  }

  async start() {
    this.header.mount();
    this.config = await this._loadConfig();
    this.rotation = new Rotation(this._enabledPanels(), {
      choresDwellSec: this.config.chores_dwell_sec,
      otherDwellSec:  this.config.other_dwell_sec,
    });
    this.sleepCheckTimer = setInterval(() => this._checkSleep(), 60_000);
    this._checkSleep();
    if (!this.sleeping) await this._mountCurrent();
    this._openSSE();
  }

  async _loadConfig() {
    const r = await fetch('/api/wall/config').then(r => r.json());
    return r;
  }

  _enabledPanels() {
    return this.config.enabled_panels.split(',').map(s => s.trim()).filter(s => PANEL_REGISTRY[s] || s === 'chores');
  }

  async _mountCurrent() {
    const key = this.rotation.current();
    const mod = PANEL_REGISTRY[key];
    if (!mod) { this._scheduleNext(); return; }
    let result;
    try { result = await mod.fetch(); } catch { result = { skip: true, reason: 'fetch threw' }; }
    if (result?.skip) {
      this.rotation.advance(() => false);   // skip-on-fetch is handled by advancing now
      // If we're back on chores (no others enabled) just sit on chores even if its fetch failed.
      if (this.rotation.current() === key) return;
      return this._mountCurrent();
    }
    const host = document.createElement('div');
    host.className = 'wall-panel is-active';
    this.stageEl.appendChild(host);
    if (this.activePanelEl) {
      const old = this.activePanelEl;
      const oldMod = this.activePanel;
      old.classList.remove('is-active');
      old.classList.add('is-leaving');
      setTimeout(() => { try { oldMod?.unmount?.(); } catch {} old.remove(); }, 450);
    }
    this.activePanel = mod;
    this.activePanelEl = host;
    this.activeData = result.data;
    mod.mount(host, result.data);
    if (key === 'chores' && mod.extractStreakLeader) {
      this.header.setStreakLeader(mod.extractStreakLeader(result.data));
    }
    this._scheduleNext();
  }

  _scheduleNext() {
    if (this.dwellTimer) clearTimeout(this.dwellTimer);
    if (!this.rotation || this.sleeping) return;
    this.dwellTimer = setTimeout(async () => {
      this.rotation.advance(() => false);
      await this._mountCurrent();
    }, this.rotation.nextDwellMs());
  }

  _openSSE() {
    if (this.sleeping) return;
    try {
      this.es = new EventSource('/api/wall/events');
      this.es.addEventListener('refresh', () => this._onSseRefresh());
      this.es.onerror = () => {
        try { this.es.close(); } catch {}
        this.es = null;
        setTimeout(() => this._openSSE(), this.sseBackoffMs);
        this.sseBackoffMs = Math.min(this.sseBackoffMs * 2, 5 * 60_000);
      };
      this.es.onopen = () => { this.sseBackoffMs = 1000; };
    } catch {
      setTimeout(() => this._openSSE(), 5000);
    }
  }

  async _onSseRefresh() {
    if (this.sleeping) return;
    if (!this.activePanel || this.activePanel.key !== 'chores') return;
    try {
      const result = await this.activePanel.fetch();
      if (result?.skip || !result?.data) return;
      this.activeData = result.data;
      this.activePanel.refresh?.(result.data);
      if (this.activePanel.extractStreakLeader) {
        this.header.setStreakLeader(this.activePanel.extractStreakLeader(result.data));
      }
    } catch { /* ignore */ }
  }

  _checkSleep() {
    const inSleep = isInSleepWindow(nowHHMM(), this.config.sleep_start, this.config.sleep_end);
    if (inSleep && !this.sleeping) this._enterSleep();
    else if (!inSleep && this.sleeping) this._exitSleep();
  }

  _enterSleep() {
    this.sleeping = true;
    if (this.dwellTimer) clearTimeout(this.dwellTimer);
    if (this.es) { try { this.es.close(); } catch {} this.es = null; }
    if (this.activePanel) { try { this.activePanel.unmount?.(); } catch {} }
    if (this.activePanelEl) { this.activePanelEl.remove(); this.activePanelEl = null; this.activePanel = null; }
    this.header.hide();
    this.sleepClock = new SleepClock(this.sleepEl, this.config.sleep_clock_style);
    this.sleepClock.mount();
  }

  async _exitSleep() {
    this.sleeping = false;
    if (this.sleepClock) { this.sleepClock.unmount(); this.sleepClock = null; }
    this.header.show();
    this.rotation.setEnabled(this._enabledPanels()); // reset to chores
    await this._mountCurrent();
    this._openSSE();
  }
}
