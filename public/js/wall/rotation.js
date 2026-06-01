// Rotation: chores-heavy smart cycle.
//
// Pattern with [chores, A, B, C] enabled:
//   chores  A  chores  B  chores  C  chores  A  ...
//
// Internal state: `_current` is the panel currently shown; `_otherIdx` is the
// position in the others list of the NEXT "other" panel to visit.

const MAX_SKIP_HOPS = 16; // safety against infinite skip loops

export class Rotation {
  constructor(enabled, { choresDwellSec = 60, otherDwellSec = 15 } = {}) {
    this._choresMs = choresDwellSec * 1000;
    this._otherMs  = otherDwellSec  * 1000;
    this.setEnabled(enabled);
  }

  setEnabled(enabled) {
    this._enabled = enabled.slice();
    this._others = this._enabled.filter(p => p !== 'chores');
    this._otherIdx = 0;
    this._current = 'chores';
  }

  current() { return this._current; }

  nextDwellMs() {
    return this._current === 'chores' ? this._choresMs : this._otherMs;
  }

  // shouldSkip(panelKey) -> bool. Called by advance() when it picks a candidate.
  advance(shouldSkip) {
    if (this._others.length === 0) return;
    if (this._current !== 'chores') {
      this._current = 'chores';
      return;
    }
    // We're on chores; pick the next non-chores panel, honoring skip.
    let hops = 0;
    while (hops < MAX_SKIP_HOPS) {
      const candidate = this._others[this._otherIdx % this._others.length];
      this._otherIdx = (this._otherIdx + 1) % this._others.length;
      if (!shouldSkip(candidate)) {
        this._current = candidate;
        return;
      }
      hops++;
    }
    // All others skipped; park on chores.
    this._current = 'chores';
  }
}
