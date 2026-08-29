import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { labelFor, colorFor, labelFmt } from "./colors.js";
import { log } from "./log.js";
import { parsePanesFile } from "./roster.js";

// ---------- pure arg builders (unit-tested) ----------
export function splitRightArgs(launch: string, target?: string, cwd?: string): string[] {
  const a = ["split-window", "-P", "-F", "#{pane_id}", "-h", "-d"];
  if (target) a.push("-t", target);
  if (cwd) a.push("-c", cwd);
  a.push(launch);
  return a;
}
export function splitDownArgs(launch: string, target: string, cwd?: string): string[] {
  const a = ["split-window", "-P", "-F", "#{pane_id}", "-v", "-d", "-t", target];
  if (cwd) a.push("-c", cwd);
  a.push(launch);
  return a;
}
export function preflightSplitArgs(flag: "-h" | "-v", prev: string, cwd?: string): string[] {
  const a = ["split-window", "-P", "-F", "#{pane_id}", flag, "-d", "-t", prev];
  if (cwd) a.push("-c", cwd);
  return a;
}
export function respawnArgs(pane: string, launch: string, cwd?: string): string[] {
  const a = ["respawn-pane", "-k", "-t", pane];
  if (cwd) a.push("-c", cwd);
  a.push(launch);
  return a;
}
// ---------- detached session placement (pure builders) ----------
/** Exact-match tmux target. A BARE session name is PREFIX-matched: verified against tmux 3.x, with
 *  only `ap-foobar` on the server, `has-session -t ap-foo` exits 0 and `new-window -t ap-foo:` opens
 *  its window INSIDE `ap-foobar`. That is a worker silently placed in a stranger's session, so every
 *  session-scoped target ap builds goes through this `=` form, which matches nothing but the exact
 *  name. `new-session -s` is deliberately NOT wrapped: it names the session being created. */
export function sessionTarget(session: string): string { return `=${session}`; }

/** tmux forbids `.` and `:` in a session name (both are target separators), and a leading `-` would
 *  parse as a flag. `ap-<topic>` always passes, topic being slug-gated upstream, but `--session` is
 *  an operator argument and is gated here rather than trusted. */
const SESSION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export function validSessionName(s: string): boolean { return SESSION_NAME_RE.test(s); }

export function displayMessageArgs(fmt: string): string[] { return ["display-message", "-p", fmt]; }

/** What `display-message -p '#S'` said, reduced to a session name ap will RECORD: its first line,
 *  trimmed, and only when tmux itself would accept it as a name. Anything else is "". The value is
 *  interpolated into the job hub's brief, so a multi-line or exotic answer must not be carried
 *  through — and an empty answer is a first-class outcome here (the hub simply skips its hint),
 *  never an error. */
export function parseSessionName(stdout: string): string {
  const first = (stdout.split("\n")[0] ?? "").trim();
  return validSessionName(first) ? first : "";
}

/** First worker into a detached session: create it. `-d` so it never steals the caller's terminal;
 *  `-P -F #{pane_id}` so this returns the same thing the split builders return. */
export function newSessionArgs(session: string, launch: string, cwd?: string): string[] {
  const a = ["new-session", "-P", "-F", "#{pane_id}", "-d", "-s", session];
  if (cwd) a.push("-c", cwd);
  a.push(launch);
  return a;
}
/** Every later worker into an EXISTING detached session: its own window, so `tmux attach` shows one
 *  window per worker instead of a shrinking grid of splits. */
export function newWindowArgs(session: string, launch: string, cwd?: string): string[] {
  const a = ["new-window", "-P", "-F", "#{pane_id}", "-d", "-t", `${sessionTarget(session)}:`];
  if (cwd) a.push("-c", cwd);
  a.push(launch);
  return a;
}
export function hasSessionArgs(session: string): string[] {
  return ["has-session", "-t", sessionTarget(session)];
}
export function killSessionArgs(session: string): string[] {
  return ["kill-session", "-t", sessionTarget(session)];
}
/** `-s` scopes the listing to the SESSION (all of its windows), not the current window. */
export function sessionPanesArgs(session: string): string[] {
  return ["list-panes", "-s", "-t", sessionTarget(session), "-F", "#{pane_id}"];
}

export function setOptionArgs(pane: string, opt: string, val: string): string[] {
  return ["set-option", "-p", "-t", pane, opt, val];
}
/** Stamp a pane with its ownership nonce. A raw pane id (%N) is NOT proof of ownership — tmux
 *  restarts the %N counter from 0 on a fresh server, so a recorded id that outlived its pane can
 *  name a stranger's pane. @ap_nonce is the per-pane secret ap mints when it CREATES the pane and
 *  records next to the id; every destructive/typing action re-reads it live and acts only on a
 *  match. respawn-pane preserves pane options, so the nonce survives the respawn paths. */
export function paneNonceSetArgs(pane: string, nonce: string): string[] {
  return setOptionArgs(pane, "@ap_nonce", nonce);
}
/** Stamp a pane with the state dir its worker was actually given (`workerDir`, the same absolute
 *  path identityWrite embedded in the worker's identity.md). The pane is the ONLY reference hub and
 *  worker share that does not itself derive from the hub's cwd, so this is what lets a hub prove --
 *  before it types a nudge -- that the tree it resolved is the tree the worker reads. Written by the
 *  same mechanism and in the same fail-closed place as @ap_nonce, so neither stamp exists without
 *  the other. */
export function paneStateSetArgs(pane: string, dir: string): string[] {
  return setOptionArgs(pane, "@ap_state", dir);
}
const PANE_ID_RE = /^%\d+$/;
/** The shape `randomUUID()` produces, and the ONLY shape an ownership check honours. The generator
 *  (spawn / preflightLayout) and this pattern change together. */
const NONCE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Parse `list-panes -a -F '#{pane_id}\t#{@ap_nonce}'` output into id -> nonce. A pane with no
 *  @ap_nonce (never ours, or pre-nonce) yields an empty field, i.e. "". Blank lines are skipped.
 *  Shared with the @ap_state snapshot (livePaneOption): the format and every hardening rule below
 *  are identical, only the option name in the -F string differs.
 *
 *  Hardened against a forged option value: tmux allows a NEWLINE inside a pane option, so a pane
 *  whose @ap_nonce contains one injects extra "rows" into this snapshot — the single oracle every
 *  kill/nudge consults. Three cheap defenses: a row whose id field is not a real `%N` is dropped;
 *  a DUPLICATE id is poisoned to "" (never matches) instead of letting a later row overwrite the
 *  server's own answer for a real pane; and `realIds` — tmux's OWN id list, which no option value
 *  can forge because tmux assigns `%N` — drops any row naming a pane that is not on the server.
 *  Forging still needs a pane on the same server plus the victim's recorded nonce, so this is
 *  hardening, not a trust boundary. */
export function parsePaneNonces(stdout: string, realIds?: Set<string>): Map<string, string> {
  const m = new Map<string, string>();
  const dup = new Set<string>();
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    const id = tab < 0 ? line : line.slice(0, tab);   // tolerate a tmux that drops the empty field
    if (!PANE_ID_RE.test(id)) continue;
    if (realIds && !realIds.has(id)) continue;        // a phantom row from a forged option value
    if (m.has(id)) { dup.add(id); continue; }
    m.set(id, tab < 0 ? "" : line.slice(tab + 1));
  }
  for (const id of dup) m.set(id, "");
  return m;
}
/** The one ownership predicate: the pane is live AND carries exactly the nonce we recorded for it.
 *  A recorded nonce that is not a platform-minted UUID — empty (a pane.json written by a pre-nonce
 *  ap, or a legacy preflight row) or any other value — never matches: "we cannot prove it is ours"
 *  is treated as "not ours". NOTE for liveness callers: not-ours is not the same as DEAD. An empty
 *  recorded nonce means UNKNOWN, and every liveness site must degrade to its pre-nonce behavior
 *  rather than read this `false` as a death verdict. */
export function ownsPane(snapshot: Map<string, string>, pane: string, nonce: string): boolean {
  return NONCE_RE.test(nonce) && snapshot.get(pane) === nonce;
}
/** Is this RECORDED nonce one a tmux answer could ever settle? Callers that must distinguish "the
 *  pane is gone" from "we could never have proven it either way" need this: ownsPane collapses both
 *  into false, and reading that false as a death verdict is exactly the 0.5.30 bug. The generator
 *  (randomUUID) and NONCE_RE change together, so this is the shape's only public reader. */
export function verifiableNonce(nonce: string): boolean { return NONCE_RE.test(nonce); }
export function sendKeysLiteralArgs(pane: string, line: string): string[] {
  return ["send-keys", "-t", pane, "-l", line];
}
export function sendKeysEnterArgs(pane: string): string[] {
  return ["send-keys", "-t", pane, "Enter"];
}

// Pane-border config so the per-pane @ap_label_fmt (stamped by paneLabelSet) actually renders on the
// pane border. Without it the border shows the program's own pane title (the raw TUI name). Rebranded
// port of the prior bash plugin's tmux.conf convention to the @ap_ user-options; falls back to #{pane_title}
// for panes with no @ap_ label (e.g. the conductor). The `#,` is an escaped comma inside #[...].
export function paneBorderArgs(): string[][] {
  return [
    ["set-option", "-g", "pane-border-status", "top"],
    ["set-option", "-g", "pane-border-format",
      " #{?@ap_label_fmt,#{@ap_label_fmt},#[fg=#{?@ap_color,#{@ap_color},default}#,bold]#{?@ap_label,#{@ap_label},#{pane_title}}#[default]} "],
    ["set-hook", "-g", "after-select-pane",
      'set-option -g pane-active-border-style "fg=#{?@ap_color,#{@ap_color},green}"'],
  ];
}
/** Force pane-border-status on a specific window (by pane or window id) so a window-local
 *  `pane-border-status off` can't suppress the @ap_ worker label that paneLabelSet stamped. */
export function windowBorderStatusArgs(target: string): string[] {
  return ["set-option", "-w", "-t", target, "pane-border-status", "top"];
}
export function wrapLaunch(launch: string, hasBashrc: boolean = existsSync(join(homedir(), ".bashrc"))): string {
  return hasBashrc ? `bash -ic 'exec ${launch}'` : launch;
}
export function sentinelCommand(coloredLabel: string): string {
  // printf the colored label + reserved notice, then hold the pane open. The hold-open loop uses
  // bounded sleeps: BSD sleep (macOS) rejects `sleep infinity`, which killed the pane before
  // preflight could stamp its nonce (#143).
  return `printf '%s\\n  preflight pane reserved — awaiting spawn...\\n' ${JSON.stringify(coloredLabel)}; while :; do sleep 3600; done`;
}

// ---------- subprocess wrappers (live tmux) ----------
const execFileP = promisify(execFile);
/** One `tmux` invocation, its stdout stripped of the single trailing newline tmux emits — the shape
 *  every caller below was written against. Rejects on a non-zero exit (and on ENOENT), which is what
 *  the fail-quiet try/catch sites read as "no tmux answer". maxBuffer is raised off execFile's 1MB
 *  default so a full `capture-pane -e` can never truncate into a spurious rejection. */
async function run(args: string[]): Promise<string> {
  const { stdout } = await execFileP("tmux", args, { maxBuffer: 100_000_000 });
  return stdout.replace(/\r?\n$/, "");
}
async function tmux(args: string[]): Promise<string> {
  return (await run(args)).trim();
}
export const splitRight = (launch: string, target?: string, cwd?: string) => tmux(splitRightArgs(launch, target, cwd));
export const splitDown = (launch: string, target: string, cwd?: string) => tmux(splitDownArgs(launch, target, cwd));
// respawn-pane reuses the SAME pane (and prints nothing), so the resulting pane id IS the target.
// Return it explicitly — never the empty stdout, which would leave callers with a blank pane id.
export const respawn = async (pane: string, launch: string, cwd?: string): Promise<string> => {
  await tmux(respawnArgs(pane, launch, cwd));
  return pane;
};

export const newSession = (session: string, launch: string, cwd?: string) => tmux(newSessionArgs(session, launch, cwd));
export const newWindow = (session: string, launch: string, cwd?: string) => tmux(newWindowArgs(session, launch, cwd));
/** Every pane id currently in `session`, across all of its windows. Empty on ANY tmux error, which
 *  includes "the session is already gone" — the reading that matters to a teardown caller, and the
 *  one that makes sessionKillable answer "nothing to kill" rather than "kill it". */
export async function sessionPaneIds(session: string): Promise<string[]> {
  try {
    return (await run(sessionPanesArgs(session))).split("\n").filter(Boolean);
  } catch { return []; }
}
/** Kill an entire session; false on any tmux error (never throws). The CALLER must have proven every
 *  pane in it is ap's (sessionKillable); this does not re-check, exactly as killGraceful takes its
 *  ownership verdict as an argument. The boolean is load-bearing, like paneNonceSet's: a caller that
 *  swallowed the failure would report a teardown it cannot prove and then clear the record that was
 *  the only evidence of what to finish. */
export async function killSession(session: string): Promise<boolean> {
  try { await run(killSessionArgs(session)); return true; } catch { return false; }
}

/** The tmux session THIS process is running inside, "" when there is none to name. Guarded by
 *  `$TMUX` rather than asked unconditionally: outside tmux the server answers for whatever session
 *  is current on it, which would record a stranger's name as the origin. Never throws — no server,
 *  no binary, and an unusable answer all read as "no return address", which is exactly the state
 *  the job hub is told to skip its completion hint on. */
export async function currentSessionName(): Promise<string> {
  if (!process.env.TMUX) return "";
  try { return parseSessionName(await tmux(displayMessageArgs("#S"))); } catch { return ""; }
}

/** Does this EXACT session exist? Never throws: no tmux server and no tmux binary both answer "no",
 *  which is the create-it direction, and the same fail-quiet posture livePaneNonces takes. */
export async function sessionExists(session: string): Promise<boolean> {
  try { await run(hasSessionArgs(session)); return true; } catch { return false; }
}

/** Apply the orchestra pane-border config (idempotent `set -g`) so worker labels render on the
 *  border instead of the raw TUI title. Called from spawn; tolerant of tmux errors. Returns
 *  false if any set-option failed (caller may warn). */
export async function ensurePaneBorders(): Promise<boolean> {
  // The three set-option/set-hook calls are independent globals — issue them together.
  const rs = await Promise.all(paneBorderArgs().map(async (a) => { try { await tmux(a); return true; } catch { return false; } }));
  return rs.every((r) => r);
}

/** Set pane-border-status top on `target`'s window; false on tmux error (never throws). */
export async function ensureWindowBorderStatus(target: string): Promise<boolean> {
  try { await tmux(windowBorderStatusArgs(target)); return true; } catch { return false; }
}

/** One snapshot of every live pane id on the server AND its ownership nonce (single tmux call).
 *  Use this when checking many panes at once (e.g. `ap list`, a teardown batch) instead of probing
 *  per pane — N panes would otherwise re-run the identical full-server scan N times. This replaced
 *  the id-only `livePanes`/`paneAlive` pair outright: an id-only liveness answer is exactly the
 *  evidence that let a stale id name a stranger's pane, so the primitive no longer exists. */
export async function livePaneNonces(): Promise<Map<string, string>> {
  // Two listings, issued together: the pairs, plus tmux's own id list. Only the second is
  // unforgeable (a pane option can carry a newline; a pane_id cannot), so it is what decides WHICH
  // panes exist — see parsePaneNonces. A pane appearing/vanishing between the two only ever drops a
  // row, which reads as "not ours", the fail-closed direction.
  //
  // NEVER throws (matching ensurePaneBorders/ensureWindowBorderStatus above): no tmux server
  // running, tmux not installed, and a server with no panes are indistinguishable here and all mean
  // the same thing — ap cannot prove it owns anything. The empty map answers every ownership
  // question with "not ours", so nothing is killed, nudged, or called alive. Callers reach this from
  // paths that must survive a tmux-less machine (a headless box, a container, CI).
  return livePaneOption("@ap_nonce");
}

/** The snapshot both pane options are read through. Kept as ONE body so @ap_state inherits every
 *  hardening @ap_nonce has (the unforgeable id list, the phantom/duplicate rules) rather than
 *  growing a second, weaker copy. */
async function livePaneOption(opt: string): Promise<Map<string, string>> {
  try {
    const [ids, pairs] = await Promise.all([
      run(["list-panes", "-a", "-F", "#{pane_id}"]),
      run(["list-panes", "-a", "-F", `#{pane_id}\t#{${opt}}`]),
    ]);
    return parsePaneNonces(pairs, new Set(ids.split("\n").filter(Boolean)));
  } catch { return new Map(); }
}

/** The state dir stamped on `pane`, or "" when there is none to compare: an unstamped pane (a worker
 *  spawned by a pre-@ap_state release), a pane that is gone, or no tmux at all. "" is UNVERIFIED,
 *  never "mismatched" -- the caller must proceed on it, exactly as classifyTestRun refuses to read a
 *  check that could not run as a failure. Never throws. */
export async function paneStateRead(pane: string): Promise<string> {
  return (await livePaneOption("@ap_state")).get(pane) ?? "";
}

/** Is `pane` live and ours (its live @ap_nonce is the one we recorded)? The single-pane form of
 *  ownsPane; an unverifiable recorded nonce short-circuits without a tmux call. Never throws — a
 *  tmux-less machine answers `false` (not ours), never an exception in the caller's face. */
export async function paneOwned(pane: string, nonce: string): Promise<boolean> {
  if (!NONCE_RE.test(nonce)) return false;   // unverifiable: no tmux call can settle it
  return ownsPane(await livePaneNonces(), pane, nonce);
}

export interface PreflightOrphanDeps {
  killPane(pane: string): Promise<void>;
  /** ONE server-wide pane+nonce snapshot for the whole sweep. */
  livePaneNonces(): Promise<Map<string, string>>;
}

/** Teardown's preflight-orphan sweep, shared by explore and autoresearch: kill every pane
 *  `<art>/preflight-panes.txt` names that STILL carries the nonce preflight recorded for it. A stale
 *  art dir names ids a restarted tmux has handed to other programs, so a live-but-not-ours pane is
 *  warned about and left alone. No-op when the file is absent (tests/dogfood). Best-effort
 *  throughout; the only per-command difference is the `label` woven into the mismatch warning. */
export async function killPreflightOrphans(art: string, deps: PreflightOrphanDeps, label: string): Promise<void> {
  const pf = join(art, "preflight-panes.txt");
  if (!existsSync(pf)) return;
  const live = await deps.livePaneNonces().catch(() => new Map<string, string>());
  for (const pin of parsePanesFile(readFileSync(pf, "utf8")).values()) {
    if (!ownsPane(live, pin.pane, pin.nonce)) {
      if (live.has(pin.pane)) log.warn(`${label} pane ${pin.pane} is live but is not ours (nonce mismatch) — not killing it`);
      continue;
    }
    try { await deps.killPane(pin.pane); } catch { /* best-effort */ }
  }
}

/** Stamp the pane's ownership nonce; false on any tmux error (never throws). The boolean is
 *  load-bearing, unlike the cosmetic label/border setters: a pane that did not take the stamp can
 *  never be proven ours again, so the CALLER must fail closed rather than record a nonce the pane
 *  does not carry. */
export async function paneNonceSet(pane: string, nonce: string): Promise<boolean> {
  try { await run(paneNonceSetArgs(pane, nonce)); return true; } catch { return false; }
}

/** Stamp the pane's state dir; false on any tmux error (never throws). Load-bearing exactly as
 *  paneNonceSet is: a pane that did not take this stamp can never prove which tree its worker reads,
 *  so the CALLER must fail closed rather than leave the pane half-stamped. */
export async function paneStateSet(pane: string, dir: string): Promise<boolean> {
  try { await run(paneStateSetArgs(pane, dir)); return true; } catch { return false; }
}

export async function paneSend(pane: string, line: string): Promise<void> {
  await run(sendKeysLiteralArgs(pane, line));
  await new Promise((r) => setTimeout(r, 300)); // load-bearing beat before Enter
  await run(sendKeysEnterArgs(pane));
}

export async function capturePane(pane: string, lines?: number): Promise<string> {
  try {
    const out = await run(["capture-pane", "-p", "-t", pane]);
    return lines ? out.split("\n").slice(-lines).join("\n") : out;
  } catch { return ""; }
}

export async function killNow(pane: string): Promise<void> {
  try { await run(["kill-pane", "-t", pane]); } catch { /* tolerate */ }
}

export async function selectLayoutMainVertical(target: string): Promise<void> {
  await run(["select-layout", "-t", target, "main-vertical"]);
}

export async function conductorPane(): Promise<string> {
  if (process.env.TMUX_PANE) return process.env.TMUX_PANE;
  return tmux(["display-message", "-p", "#{pane_id}"]);
}

// --- pane labels (the three @ap_* user-options) ---
export function paneLabelSetArgs(pane: string, agent: string, model: string, topic: string): string[][] {
  return [
    setOptionArgs(pane, "@ap_label", labelFor(agent, model, topic)),
    setOptionArgs(pane, "@ap_color", colorFor(agent)),
    setOptionArgs(pane, "@ap_label_fmt", labelFmt(agent, model, topic)),
  ];
}
export async function paneLabelSet(pane: string, agent: string, model: string, topic: string): Promise<void> {
  // The three @ap_* set-options are independent — issue them together.
  await Promise.all(paneLabelSetArgs(pane, agent, model, topic).map((args) => run(args)));
}

// --- graceful kill with DONE banner ---
export function gracefulRespawnCommand(snap: string, pluginRoot: string, label: string, color: string): string {
  return `cat '${snap}'; node '${pluginRoot}/dist/ap.cjs' _banner '${label}' '${color}'; rm -f '${snap}'`;
}

async function paneOption(pane: string, opt: string): Promise<string> {
  try { return await run(["display-message", "-p", "-t", pane, opt]); } catch { return ""; }
}

/** `owned` is the caller's ownership verdict from its livePaneNonces() snapshot — required, not a
 *  probe fallback: this respawns (-k) the pane, so it must never run on a pane we cannot prove is
 *  ours. */
export async function killGraceful(pane: string, pluginRoot: string, owned: boolean): Promise<void> {
  if (!owned) return;
  const label = (await paneOption(pane, "#{@ap_label}")) || "worker";
  const color = await paneOption(pane, "#{@ap_color}");
  const snap = join(mkdtempSync(join(tmpdir(), "cs-snap-")), "snap.txt");
  try {
    writeFileSync(snap, await run(["capture-pane", "-p", "-e", "-t", pane]));
  } catch { writeFileSync(snap, ""); }
  await respawn(pane, gracefulRespawnCommand(snap, pluginRoot, label, color));
}

// --- preflight grid ---
export interface PreflightEntry { agent: string; model: string; cwd?: string; }
export async function preflightLayout(topic: string, list: PreflightEntry[], opts: { writePanes: (tsv: string) => void }): Promise<Array<{ agent: string; pane: string; nonce: string }>> {
  const conductor = await conductorPane();
  const created: string[] = [];
  const out: Array<{ agent: string; pane: string; nonce: string }> = [];
  let prev = conductor;
  let flag: "-h" | "-v" = "-h";
  try {
    for (const e of list) {
      const sentinel = sentinelCommand(labelFmt(e.agent, e.model, topic));
      const args = [...preflightSplitArgs(flag, prev, e.cwd), sentinel];
      const pane = (await run(args)).trim();
      created.push(pane);
      // Stamp ownership at CREATION: preflight-panes.txt outlives the tmux server (teardown sweeps
      // it much later), so its ids need the same proof pane.json's do. spawn re-stamps the same
      // nonce when it respawns this pane into a worker, so one nonce follows the pane end to end.
      const nonce = randomUUID();
      // Fail the whole preflight rather than record a pane whose ownership can never be proven:
      // the catch below kills every pane created so far, so nothing unownable is left behind.
      if (!(await paneNonceSet(pane, nonce))) throw new Error(`could not stamp @ap_nonce on ${pane}`);
      await paneLabelSet(pane, e.agent, e.model, topic);
      out.push({ agent: e.agent, pane, nonce });
      prev = pane;
      flag = "-v";
    }
    await selectLayoutMainVertical(conductor);
    await ensureWindowBorderStatus(conductor);
    opts.writePanes(out.map((o) => `${o.agent}\t${o.pane}\t${o.nonce}`).join("\n") + "\n");
    return out;
  } catch (e) {
    for (const p of created) { try { await run(["kill-pane", "-t", p]); } catch { /* */ } }
    throw e;
  }
}
