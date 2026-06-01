// Wall Suite bootstrap. Wires up the stage with header + sleep overlay.
// The heavy lifting lives in /js/wall/stage.js.
import { Stage } from '/js/wall/stage.js';

const stage = new Stage({
  stageEl:  document.getElementById('wall-stage'),
  headerEl: document.getElementById('wall-header'),
  sleepEl:  document.getElementById('wall-sleep'),
});
stage.start().catch(err => {
  // Fall back to a plain message so the wall never goes fully blank on bootstrap error.
  document.body.innerHTML = `<pre style="color:#888;font:14px monospace;padding:24px">Wall failed to start: ${err.message}</pre>`;
});
