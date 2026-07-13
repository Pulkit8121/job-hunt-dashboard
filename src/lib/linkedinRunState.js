// Tracks the single in-flight LinkedIn automation run so background cron jobs
// don't start overlapping browser sessions.
let controller = null;

export function startRun() {
  if (controller) return null;
  controller = new AbortController();
  return controller;
}

export function stopRun() {
  if (!controller) return false;
  controller.abort();
  return true;
}

export function finishRun() {
  controller = null;
}

export function isRunning() {
  return !!controller;
}
