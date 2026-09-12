const { exec } = require("node:child_process");

// Google Drive for desktop ships as GoogleDriveFS.exe. Older installs (Backup and Sync,
// and the original Drive client) used the other two names, and any of them counts as
// "running". Matching across all three keeps this working on a machine that has not been
// migrated to the current client.
const DRIVE_PROCESS_NAMES = ["GoogleDriveFS.exe", "GoogleDrive.exe", "googledrivesync.exe"];

// The point of the indicator is to notice that Drive has died and restart it, so a check
// every 3 hours is plenty — this is a "has it quietly stopped?" canary, not monitoring.
const DEFAULT_CHECK_INTERVAL_MS = 3 * 60 * 60 * 1000;

// One unfiltered listing rather than three filtered ones: fewer process spawns, and it
// matches every name variant in a single pass.
const TASKLIST_COMMAND = "tasklist /NH /FO CSV";

// Pure: tasklist CSV is "Image Name","PID",... per line, so a case-insensitive substring
// test is enough (and tolerates the "INFO: No tasks are running..." notice).
function parseTasklistOutput(stdout, names = DRIVE_PROCESS_NAMES) {
  const haystack = String(stdout || "").toLowerCase();
  return names.filter((name) => haystack.includes(name.toLowerCase()));
}

function runTasklist(execImpl = exec) {
  return new Promise((resolve, reject) => {
    execImpl(TASKLIST_COMMAND, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(String(stdout || ""));
    });
  });
}

// States the UI distinguishes: running / stopped / unknown / unsupported.
// "unknown" and "unsupported" are deliberately separate from "stopped" — a failed check
// must never look like a dead Drive and send the user off to restart a healthy one.
async function checkGoogleDrive({ platform = process.platform, execImpl } = {}) {
  if (platform !== "win32") {
    return {
      state: "unsupported",
      matched: [],
      detail: `The Google Drive process check is implemented for Windows only; this host reports "${platform}".`
    };
  }

  try {
    const stdout = await runTasklist(execImpl || exec);
    const matched = parseTasklistOutput(stdout);
    return matched.length
      ? { state: "running", matched, detail: `Running: ${matched.join(", ")}` }
      : { state: "stopped", matched: [], detail: "No Google Drive process is running on this machine." };
  } catch (err) {
    return { state: "unknown", matched: [], detail: `Could not list processes: ${err && err.message ? err.message : err}` };
  }
}

// Holds the last result so the page can render instantly instead of waiting on a process
// listing, re-checks on an interval, and reuses an in-flight check so a manual refresh
// racing the timer does not spawn two listings.
function createGoogleDriveMonitor({ intervalMs = DEFAULT_CHECK_INTERVAL_MS, checkFn = checkGoogleDrive, now = () => Date.now() } = {}) {
  let latest = null;
  let timer = null;
  let inFlight = null;

  async function checkNow() {
    if (inFlight) return inFlight;

    inFlight = (async () => {
      const result = await checkFn();
      latest = { ...result, checkedAt: new Date(now()).toISOString() };
      return latest;
    })();

    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  function getStatus() {
    if (!latest) {
      return {
        state: "pending",
        matched: [],
        detail: "No check has run yet.",
        checkedAt: null,
        intervalMs,
        nextCheckAt: null
      };
    }
    return {
      ...latest,
      intervalMs,
      nextCheckAt: new Date(new Date(latest.checkedAt).getTime() + intervalMs).toISOString()
    };
  }

  function start() {
    if (timer) return;
    checkNow().catch(() => {});
    timer = setInterval(() => {
      checkNow().catch(() => {});
    }, intervalMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { checkNow, getStatus, start, stop };
}

module.exports = {
  DRIVE_PROCESS_NAMES,
  DEFAULT_CHECK_INTERVAL_MS,
  TASKLIST_COMMAND,
  parseTasklistOutput,
  checkGoogleDrive,
  createGoogleDriveMonitor,
};
