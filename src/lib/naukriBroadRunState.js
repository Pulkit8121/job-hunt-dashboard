// Tracks the single in-flight broad-search run so overlapping cron triggers
// (or a manual click during the nightly run) don't drive two Naukri sessions.
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
