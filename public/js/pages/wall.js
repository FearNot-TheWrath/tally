// Wall Suite bootstrap. Wires up the stage with header + sleep overlay.
// The heavy lifting lives in /js/wall/stage.js.

// Visible diagnostic strip pinned to the top of the page so we can SEE what's
// happening even if the rest of the wall renders empty. Remove once stable.
const diag = document.createElement('pre');
diag.id = '_wall_diag';
diag.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#222;color:#9f9;font:11px ui-monospace,monospace;padding:6px 10px;margin:0;max-height:35vh;overflow:auto;white-space:pre-wrap;border-bottom:1px solid #555;';
document.body.appendChild(diag);
function log(msg, color) {
  const line = document.createElement('div');
  line.style.color = color || '#9f9';
  line.textContent = new Date().toLocaleTimeString() + '  ' + msg;
  diag.appendChild(line);
  diag.scrollTop = diag.scrollHeight;
}
window.addEventListener('error', e => log('UNCAUGHT: ' + (e.message || e) + ' @ ' + (e.filename || '?') + ':' + (e.lineno || '?'), '#f99'));
window.addEventListener('unhandledrejection', e => log('UNHANDLED REJECTION: ' + (e.reason?.message || e.reason || e), '#f99'));
log('bootstrap loaded');

import('/js/wall/stage.js').then(({ Stage }) => {
  log('stage.js imported');
  const stage = new Stage({
    stageEl:  document.getElementById('wall-stage'),
    headerEl: document.getElementById('wall-header'),
    sleepEl:  document.getElementById('wall-sleep'),
  });
  log('Stage constructed; calling start()');
  stage.start()
    .then(() => log('stage.start() resolved'))
    .catch(err => log('stage.start() REJECTED: ' + (err?.message || err) + (err?.stack ? '\n' + err.stack : ''), '#f99'));
}).catch(err => {
  log('IMPORT FAILED: ' + (err?.message || err), '#f99');
});
