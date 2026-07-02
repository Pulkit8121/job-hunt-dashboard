// Tracks the single in-flight Naukri apply run (Next.js API routes share one
// Node process under PM2) so the UI can stop it mid-run instead of waiting for
// hundreds of jobs to finish.
let controller = null;

export function startRun() {
  if (controller) return null; // already running
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

export function getSignal() {
  return controller?.signal;
}
