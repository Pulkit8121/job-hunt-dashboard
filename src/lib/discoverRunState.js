// Tracks the single in-flight contact-discovery run so overlapping cron
// triggers (e.g. a run taking longer than the cron interval) don't stack.
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
