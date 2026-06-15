// Liveness state machine for /ap:autoresearch monitor. Faithful to
// deep-research-monitor.sh: byte-tail event emit (A), phase-gate stale/stuck (B),
// periodic whole-outbox rescan dedup (C). Pure single-scan; the verb (C7) owns the
// loop + persistence. Byte offsets are BYTES (Buffer.byteLength), never char counts.

export interface MonitorScanState {
  offset: number;                 // byte cursor into the outbox
  rescanEmitted: Set<string>;     // "<lineNum>\t<event>" dedup keys (1-based line num)
  lastStaleTs: number;            // epoch seconds (0 = never)
  lastStuckTs: number;
  lastRescan: number;
}

export interface MonitorNotification { worker: string; event: string; summary: string; ts: string; }

export interface MonitorScanResult { notifications: MonitorNotification[]; state: MonitorScanState; }

export interface MonitorDeps {
  outboxText: string;       // NEW bytes since state.offset (caller slices [offset, size))
  outboxFullText: string;   // whole outbox (for the rescan pass)
  outboxSize: number;       // current byte size
  outboxMtime: number;      // epoch seconds, 0 if missing
  phase: string;            // parseState(state.txt).phase ?? ""
  now: number;              // epoch seconds
  nowIso: string;           // ISO-8601 UTC Z
  thresholds: { probeS: number; stuckS: number; rescanEveryS: number };
}

const TAIL_EVENTS = new Set(["done", "error", "question", "heartbeat"]);
const RESCAN_EVENTS = new Set(["done", "error", "question"]);

function eventOf(line: string): { event?: string; summary?: string } {
  try {
    return JSON.parse(line) as { event?: string; summary?: string };
  } catch {
    return {};
  }
}

/** Cursor-restore + pre-seed (bash L42-88). Honors a valid persisted cursor (<= size), else EOF.
 *  Pre-seeds the rescan dedup set with every terminal event already below the restored cursor. */
export function initScanState(
  size: number, fullText: string, persistedCursor: string | null, persistedRescan: string | null,
): MonitorScanState {
  const c = persistedCursor?.replace(/\s+/g, "") ?? "";
  const offset = /^[0-9]+$/.test(c) && Number(c) <= size ? Number(c) : size;
  const rescanEmitted = new Set<string>(persistedRescan ? persistedRescan.split("\n").filter(Boolean) : []);
  if (offset > 0) {
    let bytesSeen = 0;
    let lineNum = 0;
    for (const line of fullText.split("\n")) {
      if (bytesSeen >= offset) break;
      lineNum++;
      bytesSeen += Buffer.byteLength(line) + 1;            // +1 for the stripped newline
      const ev = eventOf(line).event;
      if (ev && RESCAN_EVENTS.has(ev)) rescanEmitted.add(`${lineNum}\t${ev}`);
    }
  }
  return { offset, rescanEmitted, lastStaleTs: 0, lastStuckTs: 0, lastRescan: 0 };
}

/** One liveness scan. Pure given deps + state; never sleeps (the verb owns cadence). */
export function monitorScan(
  _outboxPath: string, worker: string, prev: MonitorScanState, d: MonitorDeps,
): MonitorScanResult {
  const notifications: MonitorNotification[] = [];
  const emit = (event: string, summary: string): void => {
    notifications.push({ worker, event, summary, ts: d.nowIso });
  };
  const state: MonitorScanState = { ...prev, rescanEmitted: new Set(prev.rescanEmitted) };

  // (A) byte-tail forward new lines
  if (d.outboxSize > state.offset && d.outboxText) {
    for (const line of d.outboxText.split("\n")) {
      if (!line) continue;
      const { event, summary } = eventOf(line);
      if (event && TAIL_EVENTS.has(event)) emit(event, summary ?? "");
    }
    state.offset = d.outboxSize;
  }

  // (B) phase-gate stale/stuck (only when working; stuck before stale; mutually exclusive)
  if (d.phase === "working" && d.outboxMtime > 0) {
    const delta = d.now - d.outboxMtime;
    if (delta >= d.thresholds.stuckS && d.now - state.lastStuckTs >= d.thresholds.stuckS) {
      emit("stuck", `outbox mtime ${delta}s old (>= ${d.thresholds.stuckS}s threshold)`);
      state.lastStuckTs = d.now;
    } else if (delta >= d.thresholds.probeS && d.now - state.lastStaleTs >= d.thresholds.probeS) {
      emit("stale", `outbox mtime ${delta}s old (>= ${d.thresholds.probeS}s threshold)`);
      state.lastStaleTs = d.now;
    }
  }

  // (C) periodic whole-outbox rescan safety net
  if (d.now - state.lastRescan >= d.thresholds.rescanEveryS && d.outboxFullText) {
    let lineNum = 0;
    for (const line of d.outboxFullText.split("\n")) {
      if (!line) {
        lineNum++;
        continue;
      }
      lineNum++;
      const { event, summary } = eventOf(line);
      if (event && RESCAN_EVENTS.has(event)) {
        const key = `${lineNum}\t${event}`;
        if (!state.rescanEmitted.has(key)) {
          emit(event, `${summary ?? ""} (rescan)`);
          state.rescanEmitted.add(key);
        }
      }
    }
    state.lastRescan = d.now;
  }

  return { notifications, state };
}
