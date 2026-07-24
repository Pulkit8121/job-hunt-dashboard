// Tracks the single in-flight mail-scan run so overlapping triggers (cron +
// manual click) don't open two concurrent IMAP connections.
let running = false;

export function startRun() {
  if (running) return false;
  running = true;
  return true;
}

export function finishRun() {
  running = false;
}

export function isRunning() {
  return running;
}
