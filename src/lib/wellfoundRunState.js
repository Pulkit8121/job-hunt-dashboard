// Tracks the single in-flight Wellfound apply run so overlapping cron triggers
// (or a manual click during the scheduled run) don't drive two browser sessions
// against the same VNC Chrome at once — the server has 1 CPU core, so any two
// concurrent Puppeteer pipelines starve each other and risk OOM.
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
