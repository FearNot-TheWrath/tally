import { EventEmitter } from 'node:events';

export const wallBus = new EventEmitter();
wallBus.setMaxListeners(20);

let timer = null;
export function notifyWall() {
  clearTimeout(timer);
  timer = setTimeout(() => wallBus.emit('refresh'), 100);
}
