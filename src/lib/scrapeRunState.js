// Tracks the single in-flight /api/scrape run so a client that gives up (curl
// --max-time, browser tab closed) can't leave an orphaned scrape grinding
// through thousands of companies in the background with nothing able to stop
// it or start a fresh one — that combined with an unsafe browser.close() is
// exactly what left naukri-pipeline's browser lock held for ~2 days straight.
let controller = null;

export function startRun() {
  if (controller) return null; // already running
  controller = new AbortController();
  return controller;
}

export function finishRun() {
  controller = null;
}

export function isRunning() {
  return !!controller;
}
