// Tracks the single in-flight HN "Who is hiring" discovery run so overlapping
// cron triggers don't stack. Separate from discoverRunState.js (the
// company-site discovery flow) since the two run independently.
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
