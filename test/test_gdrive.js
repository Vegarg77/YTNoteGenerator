const { describe, it } = require("node:test");
const assert = require("node:assert");

const gdrive = require("../lib/gdrive");

// Realistic tasklist /NH /FO CSV shapes.
const RUNNING_CSV = [
  '"System Idle Process","0","Services","0","8 K"',
  '"GoogleDriveFS.exe","5412","Console","1","182,440 K"',
  '"explorer.exe","3011","Console","1","95,208 K"'
].join("\r\n");

const RUNNING_OLD_CLIENT_CSV = [
  '"googledrivesync.exe","2222","Console","1","51,000 K"'
].join("\r\n");

const NOT_RUNNING_CSV = [
  '"System Idle Process","0","Services","0","8 K"',
  '"explorer.exe","3011","Console","1","95,208 K"'
].join("\r\n");

// What tasklist prints when a filtered query matches nothing (kept for robustness even
// though the command is unfiltered).
const INFO_ONLY = "INFO: No tasks are running which match the specified criteria.\r\n";

describe("parseTasklistOutput", () => {
  it("finds the current Google Drive for desktop process", () => {
    assert.deepStrictEqual(gdrive.parseTasklistOutput(RUNNING_CSV), ["GoogleDriveFS.exe"]);
  });

  it("recognises the older client name too", () => {
    assert.deepStrictEqual(gdrive.parseTasklistOutput(RUNNING_OLD_CLIENT_CSV), ["googledrivesync.exe"]);
  });

  it("returns nothing when Drive is not running", () => {
    assert.deepStrictEqual(gdrive.parseTasklistOutput(NOT_RUNNING_CSV), []);
  });

  it("returns nothing for the tasklist INFO notice", () => {
    assert.deepStrictEqual(gdrive.parseTasklistOutput(INFO_ONLY), []);
  });

  it("handles empty and missing output", () => {
    assert.deepStrictEqual(gdrive.parseTasklistOutput(""), []);
    assert.deepStrictEqual(gdrive.parseTasklistOutput(undefined), []);
  });
});

describe("checkGoogleDrive", () => {
  it("reports unsupported on a non-Windows host rather than looking stopped", async () => {
    const result = await gdrive.checkGoogleDrive({ platform: "linux" });
    assert.strictEqual(result.state, "unsupported");
    assert.match(result.detail, /Windows only/);
  });

  it("reports running when the process listing contains a Drive process", async () => {
    const execFileImpl = (file, args, opts, cb) => cb(null, RUNNING_CSV);
    const result = await gdrive.checkGoogleDrive({ platform: "win32", execFileImpl });
    assert.strictEqual(result.state, "running");
    assert.deepStrictEqual(result.matched, ["GoogleDriveFS.exe"]);
  });

  it("spawns tasklist directly, without a shell, under a deadline", async () => {
    let seen = null;
    const execFileImpl = (file, args, opts, cb) => {
      seen = { file, args, opts };
      cb(null, RUNNING_CSV);
    };
    await gdrive.checkGoogleDrive({ platform: "win32", execFileImpl });
    assert.strictEqual(seen.file, "tasklist");
    assert.deepStrictEqual(seen.args, ["/NH", "/FO", "CSV"]);
    // without a timeout a hung listing would leave the monitor wedged forever
    assert.strictEqual(seen.opts.timeout, gdrive.LISTING_TIMEOUT_MS);
  });

  it("reports stopped when the listing has no Drive process", async () => {
    const execFileImpl = (file, args, opts, cb) => cb(null, NOT_RUNNING_CSV);
    const result = await gdrive.checkGoogleDrive({ platform: "win32", execFileImpl });
    assert.strictEqual(result.state, "stopped");
    assert.match(result.detail, /No Google Drive process/);
  });

  it("reports unknown, not stopped, when the listing command fails", async () => {
    const execFileImpl = (file, args, opts, cb) => cb(new Error("tasklist is not recognized"));
    const result = await gdrive.checkGoogleDrive({ platform: "win32", execFileImpl });
    assert.strictEqual(result.state, "unknown", "a failed check must not look like a dead Drive");
    assert.match(result.detail, /tasklist is not recognized/);
  });
});

describe("createGoogleDriveMonitor", () => {
  it("starts pending until a check has run", () => {
    const monitor = gdrive.createGoogleDriveMonitor({ checkFn: async () => ({ state: "running" }) });
    const status = monitor.getStatus();
    assert.strictEqual(status.state, "pending");
    assert.strictEqual(status.checkedAt, null);
    assert.strictEqual(status.intervalMs, gdrive.DEFAULT_CHECK_INTERVAL_MS);
  });

  it("defaults to a three-hour interval", () => {
    assert.strictEqual(gdrive.DEFAULT_CHECK_INTERVAL_MS, 3 * 60 * 60 * 1000);
  });

  it("caches the result and reports the next check time", async () => {
    const fixedNow = Date.parse("2026-09-12T06:00:00.000Z");
    let calls = 0;
    const monitor = gdrive.createGoogleDriveMonitor({
      checkFn: async () => {
        calls += 1;
        return { state: "running", matched: ["GoogleDriveFS.exe"], detail: "Running: GoogleDriveFS.exe" };
      },
      now: () => fixedNow
    });

    await monitor.checkNow();
    const status = monitor.getStatus();

    assert.strictEqual(calls, 1);
    assert.strictEqual(status.state, "running");
    assert.strictEqual(status.checkedAt, "2026-09-12T06:00:00.000Z");
    assert.strictEqual(status.nextCheckAt, "2026-09-12T09:00:00.000Z", "three hours later");
  });

  it("reuses an in-flight check instead of running two listings", async () => {
    let calls = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const monitor = gdrive.createGoogleDriveMonitor({
      checkFn: async () => {
        calls += 1;
        await gate;
        return { state: "running", matched: [], detail: "" };
      }
    });

    const first = monitor.checkNow();
    const second = monitor.checkNow();
    release();
    await Promise.all([first, second]);

    assert.strictEqual(calls, 1);
  });

  it("throttles forced checks so a client cannot spawn a process per request", async () => {
    let calls = 0;
    let clock = Date.parse("2026-09-12T06:00:00.000Z");
    const monitor = gdrive.createGoogleDriveMonitor({
      now: () => clock,
      checkFn: async () => {
        calls += 1;
        return { state: "running", matched: [], detail: "" };
      }
    });

    await monitor.checkNowIfStale();
    assert.strictEqual(calls, 1);

    // a second click a couple of seconds later must reuse the fresh result
    clock += 2000;
    await monitor.checkNowIfStale();
    assert.strictEqual(calls, 1, "a recent result is reused instead of respawning");

    // past the throttle window it checks for real again
    clock += gdrive.FORCE_CHECK_MIN_AGE_MS + 1000;
    await monitor.checkNowIfStale();
    assert.strictEqual(calls, 2);
  });

  it("shares one 3-hour default with the config module", () => {
    const saved = process.env.GDRIVE_CHECK_INTERVAL_MS;
    delete process.env.GDRIVE_CHECK_INTERVAL_MS;
    try {
      const cfg = require("../lib/config");
      assert.strictEqual(cfg.getConfig().GDRIVE_CHECK_INTERVAL_MS, gdrive.DEFAULT_CHECK_INTERVAL_MS);
      assert.strictEqual(cfg.getConfig().GDRIVE_CHECK_INTERVAL_MS, 3 * 60 * 60 * 1000);
    } finally {
      if (saved !== undefined) process.env.GDRIVE_CHECK_INTERVAL_MS = saved;
    }
  });

  it("checks immediately on start and again on the interval", async () => {
    let calls = 0;
    const monitor = gdrive.createGoogleDriveMonitor({
      intervalMs: 40,
      checkFn: async () => {
        calls += 1;
        return { state: "stopped", matched: [], detail: "" };
      }
    });

    try {
      monitor.start();
      await new Promise((resolve) => setTimeout(resolve, 130));
      assert.ok(calls >= 2, `expected an immediate check plus interval ticks, saw ${calls}`);
    } finally {
      monitor.stop();
    }

    const afterStop = calls;
    await new Promise((resolve) => setTimeout(resolve, 90));
    assert.strictEqual(calls, afterStop, "stop() must end the interval");
  });
});
