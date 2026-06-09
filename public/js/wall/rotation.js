// Rotation: chores-heavy smart cycle (default) or flat round-robin.
//
// Smart cycle pattern with [chores, A, B, C] enabled:
//   chores  A  chores  B  chores  C  chores  A  ...
//
// Flat cycle (smartCycle: false) walks the enabled list in declared order.
//
// Constructor options:
//   dwellByPanel:   { panelKey: seconds, ... }  per-panel dwell times
//   smartCycle:     boolean (default true)
//   choresDwellSec: number  (legacy; sets dwellByPanel.chores if not already set)
//   otherDwellSec:  number  (legacy; sets the default dwell for unlisted panels)
//   dwellOverrides: { panelKey: seconds, ... }  (legacy; merged into dwellByPanel)

export class Rotation {
  constructor(enabled, opts = {}) {
    this._dwellByPanel = { ...(opts.dwellByPanel || {}) };
    // Merge legacy dwellOverrides into dwellByPanel
    if (opts.dwellOverrides) {
      for (const [k, v] of Object.entries(opts.dwellOverrides)) {
        if (this._dwellByPanel[k] == null) this._dwellByPanel[k] = v;
      }
    }
    // Legacy choresDwellSec maps to dwellByPanel.chores
    if (opts.choresDwellSec != null && this._dwellByPanel.chores == null) {
      this._dwellByPanel.chores = opts.choresDwellSec;
    }
    this._defaultDwellSec = opts.otherDwellSec != null ? opts.otherDwellSec : 15;
    this._smartCycle = opts.smartCycle !== false;  // default true
    this.setEnabled(enabled);
  }

  setEnabled(enabled) {
    this._enabled = enabled.slice();
    this._others = this._enabled.filter(p => p !== 'chores');
    this._otherIdx = 0;
    this._flatIdx  = 0;
    this._current = this._enabled[0] || 'chores';
  }

  current() { return this._current; }

  nextDwellMs() {
    const sec = this._dwellByPanel[this._current];
    return (sec != null ? sec : this._defaultDwellSec) * 1000;
  }

  // shouldSkip(panelKey) -> bool. Called by advance() when it picks a candidate.
  advance(shouldSkip) {
    if (!this._smartCycle) {
      // Flat rotation: walk enabled list in order, honoring skip.
      const MAX = 16;
      for (let i = 0; i < MAX; i++) {
        this._flatIdx = (this._flatIdx + 1) % this._enabled.length;
        const candidate = this._enabled[this._flatIdx];
        if (!shouldSkip(candidate)) {
          this._current = candidate;
          return;
        }
      }
      return;
    }
    // Smart cycle (default):
    if (this._others.length === 0) return;
    if (this._current !== 'chores') {
      this._current = 'chores';
      return;
    }
    const MAX = 16;
    for (let i = 0; i < MAX; i++) {
      const candidate = this._others[this._otherIdx % this._others.length];
      this._otherIdx = (this._otherIdx + 1) % this._others.length;
      if (!shouldSkip(candidate)) {
        this._current = candidate;
        return;
      }
    }
    // All others skipped; park on chores.
    this._current = 'chores';
  }
}
