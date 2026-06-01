// Wall Suite bootstrap, with a visible diagnostic strip pinned at the top.

const diag = document.createElement('pre');
diag.id = '_wall_diag';
diag.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#FFEB3B;color:#000;font:13px ui-monospace,monospace;padding:8px 10px;margin:0;max-height:50vh;overflow:auto;white-space:pre-wrap;border-bottom:3px solid #f00;';
document.body.appendChild(diag);
function log(msg, color) {
  const line = document.createElement('div');
  if (color) line.style.color = color;
  line.textContent = new Date().toLocaleTimeString() + '  ' + msg;
  diag.appendChild(line);
  diag.scrollTop = diag.scrollHeight;
}
window.addEventListener('error', e => log('UNCAUGHT: ' + (e.message || e) + ' @ ' + (e.filename || '?') + ':' + (e.lineno || '?'), '#c00'));
window.addEventListener('unhandledrejection', e => log('UNHANDLED REJECTION: ' + (e.reason?.message || e.reason || e), '#c00'));
log('bootstrap loaded; UA=' + navigator.userAgent.slice(0, 80));
log('viewport ' + window.innerWidth + 'x' + window.innerHeight + ' dpr=' + window.devicePixelRatio);
log('data-theme=' + document.documentElement.getAttribute('data-theme'));
log('prefers-dark=' + matchMedia('(prefers-color-scheme: dark)').matches);
log('computed body bg=' + getComputedStyle(document.body).backgroundColor);
log('computed body color=' + getComputedStyle(document.body).color);

import('/js/wall/stage.js').then(({ Stage }) => {
  log('stage.js imported');
  const stageEl  = document.getElementById('wall-stage');
  const headerEl = document.getElementById('wall-header');
  const sleepEl  = document.getElementById('wall-sleep');
  log('found elements: stage=' + !!stageEl + ' header=' + !!headerEl + ' sleep=' + !!sleepEl);
  const stage = new Stage({ stageEl, headerEl, sleepEl });
  log('Stage constructed; calling start()');
  stage.start()
    .then(() => {
      log('stage.start() resolved');
      log('stage children: ' + stageEl.children.length);
      log('header children: ' + headerEl.children.length);
    })
    .catch(err => log('stage.start() REJECTED: ' + (err?.message || err) + (err?.stack ? '\n' + err.stack : ''), '#c00'));
}).catch(err => {
  log('IMPORT FAILED: ' + (err?.message || err), '#c00');
});
