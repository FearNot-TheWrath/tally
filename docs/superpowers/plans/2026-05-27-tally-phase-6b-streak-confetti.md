# Tally — Phase 6b Streak Confetti Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add canvas-based confetti animations when a kid extends their streak (on their phone and on the family wall), with escalating celebrations at milestone thresholds.

**Architecture:** New `public/js/lib/confetti.js` module handles all animation. Kid home (`home.js`) compares streak against sessionStorage after each mutation. Wall (`wall.js`) compares streaks against a module-scoped cache after each SSE-triggered render. No backend changes.

**Tech Stack:** Vanilla JS, Canvas API, requestAnimationFrame. No new dependencies.

**Spec:** [`docs/superpowers/specs/2026-05-27-tally-phase-6b-streak-confetti.md`](../specs/2026-05-27-tally-phase-6b-streak-confetti.md)

---

## File Structure

```
~/projects/tally/
├── public/
│   └── js/
│       ├── lib/
│       │   └── confetti.js                          NEW: fireConfetti, streakConfetti, milestoneConfetti, isMilestone
│       └── pages/
│           ├── home.js                              MODIFY: streak comparison + confetti trigger
│           └── wall.js                              MODIFY: streak cache + confetti trigger
└── tests/
    └── confetti.test.js                             NEW: isMilestone unit tests
```

---

## Task 1: `public/js/lib/confetti.js` confetti module + isMilestone tests

**Files:**
- Create: `public/js/lib/confetti.js`
- Create: `tests/confetti.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/confetti.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMilestone } from '../public/js/lib/confetti.js';

test('isMilestone returns true for 7-day milestone', () => {
  assert.equal(isMilestone(7), true);
});

test('isMilestone returns true for 14-day milestone', () => {
  assert.equal(isMilestone(14), true);
});

test('isMilestone returns true for 30-day milestone', () => {
  assert.equal(isMilestone(30), true);
});

test('isMilestone returns true for 60-day milestone', () => {
  assert.equal(isMilestone(60), true);
});

test('isMilestone returns true for 100-day milestone', () => {
  assert.equal(isMilestone(100), true);
});

test('isMilestone returns true for multiples of 100 above 100', () => {
  assert.equal(isMilestone(200), true);
  assert.equal(isMilestone(300), true);
});

test('isMilestone returns false for non-milestone days', () => {
  assert.equal(isMilestone(1), false);
  assert.equal(isMilestone(5), false);
  assert.equal(isMilestone(15), false);
  assert.equal(isMilestone(50), false);
  assert.equal(isMilestone(150), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ~/projects/tally && npm test
```

Expected: FAIL — `public/js/lib/confetti.js` doesn't exist.

- [ ] **Step 3: Create `public/js/lib/confetti.js`**

```js
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
```

- [ ] **Step 4: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 145 tests (137 prior + 8 new isMilestone tests).

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add public/js/lib/confetti.js tests/confetti.test.js && git commit -m "feat(confetti): canvas confetti module with milestone detection"
```

---

## Task 2: Kid home confetti trigger

**Files:**
- Modify: `public/js/pages/home.js`

- [ ] **Step 1: Add import and streak comparison logic**

At the top of `public/js/pages/home.js`, add after the existing imports:

```js
import { isMilestone, streakConfetti, milestoneConfetti } from '../lib/confetti.js';
```

Inside `renderHome`, after the line that builds `const hero = ...` and before `const todaySection = ...`, add the confetti trigger:

```js
  const lastStreak = parseInt(sessionStorage.getItem('tally_last_streak') || '0', 10);
  if (p.streak_days > lastStreak && lastStreak >= 0) {
    if (isMilestone(p.streak_days)) milestoneConfetti(p.streak_days);
    else streakConfetti();
  }
  sessionStorage.setItem('tally_last_streak', String(p.streak_days));
```

Note: the `lastStreak >= 0` check is always true (parseInt returns NaN for bad input, which fails the > comparison anyway). The key guard is `p.streak_days > lastStreak` — this prevents firing on page load when the streak hasn't changed.

On first load after a fresh session (sessionStorage empty), `lastStreak` is 0. If `p.streak_days` is already > 0, confetti would fire. To prevent this initial-load confetti, seed the storage on first render without firing:

Replace the above with:

```js
  const STREAK_KEY = 'tally_last_streak';
  const storedRaw = sessionStorage.getItem(STREAK_KEY);
  if (storedRaw !== null) {
    const lastStreak = parseInt(storedRaw, 10);
    if (p.streak_days > lastStreak) {
      if (isMilestone(p.streak_days)) milestoneConfetti(p.streak_days);
      else streakConfetti();
    }
  }
  sessionStorage.setItem(STREAK_KEY, String(p.streak_days));
```

This way, the very first render just seeds the value. Subsequent renders within the same tab session fire confetti if the streak increased.

- [ ] **Step 2: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 145 tests (no new server tests).

- [ ] **Step 3: Commit**

```bash
cd ~/projects/tally && git add public/js/pages/home.js && git commit -m "feat(home): fire confetti when kid extends their streak"
```

---

## Task 3: Wall confetti trigger

**Files:**
- Modify: `public/js/pages/wall.js`

- [ ] **Step 1: Add import and streak cache logic**

At the top of `public/js/pages/wall.js`, add after the existing imports:

```js
import { isMilestone, streakConfetti, milestoneConfetti } from '../lib/confetti.js';
```

After the existing module-scope variables (`let lastDataJson = null;`), add:

```js
const wallStreakCache = new Map();
let wallFirstRender = true;
```

Inside the `render()` function, after the `requestAnimationFrame(() => { ... })` block (the auto-scroll logic) and before the closing `}` of `render`, add the confetti check:

```js
  if (wallFirstRender) {
    for (const k of data.kids) wallStreakCache.set(k.id, k.streak_days || 0);
    wallFirstRender = false;
  } else {
    for (const k of data.kids) {
      const prev = wallStreakCache.get(k.id) || 0;
      if ((k.streak_days || 0) > prev) {
        if (isMilestone(k.streak_days)) milestoneConfetti(k.streak_days, k.avatar_color);
        else streakConfetti(k.avatar_color);
      }
      wallStreakCache.set(k.id, k.streak_days || 0);
    }
  }
```

This must go AFTER the full-redraw path (not inside the clock-only early return). The clock-only path returns early at `if (headerOnly) { ... return; }`, so any code after the `requestAnimationFrame` block only runs on full redraws.

- [ ] **Step 2: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 145 tests.

- [ ] **Step 3: Commit**

```bash
cd ~/projects/tally && git add public/js/pages/wall.js && git commit -m "feat(wall): fire confetti when any kid extends their streak"
```

---

## Task 4: Deploy + tag v0.6.1-phase6b

- [ ] **Step 1: Final test run**

```bash
cd ~/projects/tally && npm test
```

Expected: 145 tests pass.

- [ ] **Step 2: Reload PM2 + verify**

```bash
cd ~/projects/tally && pm2 reload tally
sleep 3
curl -sf http://localhost:3012/api/health
```

Expected: `{"ok":true}`.

- [ ] **Step 3: Tag the release**

```bash
cd ~/projects/tally && git tag v0.6.1-phase6b && git log --oneline -8 && git tag -l 'v*'
```

---

## Self-Review

**Spec coverage:**

| Spec section | Covered by Task(s) |
|---|---|
| §1 Summary | All tasks |
| §2 Goals (reward, milestones, wall, zero deps) | Tasks 1-3 |
| §3 Non-goals | Honored (no sound, no PB, no admin, circles only) |
| §4 Confetti module | Task 1 |
| §5 Kid home trigger | Task 2 |
| §6 Wall trigger | Task 3 |
| §7-8 Schema/API (none) | No tasks needed |
| §9 Tests | Task 1 (isMilestone tests) |
| §10 Tech notes | Implementation in Tasks 1-3 |
| §11 Acceptance test | Task 4 |

**Placeholder scan:** Every step has complete code. No TBDs.

**Type consistency:**
- `isMilestone(days)` signature consistent in Tasks 1, 2, 3
- `streakConfetti(dominantColor?)` and `milestoneConfetti(days, dominantColor?)` consistent
- `wallStreakCache` Map with kid.id keys consistent with `data.kids` iteration in Task 3
- `STREAK_KEY` sessionStorage key in Task 2 is self-contained

Plan is internally consistent.
