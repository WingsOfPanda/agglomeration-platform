import { execa } from "execa";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";

// ---------- pure arg builders (unit-tested) ----------
export function splitRightArgs(launch: string, target?: string, cwd?: string): string[] {
  const a = ["split-window", "-P", "-F", "#{pane_id}", "-h"];
  if (target) a.push("-t", target);
  if (cwd) a.push("-c", cwd);
  a.push(launch);
  return a;
}
export function splitDownArgs(launch: string, target: string, cwd?: string): string[] {
  const a = ["split-window", "-P", "-F", "#{pane_id}", "-v", "-t", target];
  if (cwd) a.push("-c", cwd);
  a.push(launch);
  return a;
}
export function respawnArgs(pane: string, launch: string, cwd?: string): string[] {
  const a = ["respawn-pane", "-k", "-t", pane];
  if (cwd) a.push("-c", cwd);
  a.push(launch);
  return a;
}
export function setOptionArgs(pane: string, opt: string, val: string): string[] {
  return ["set-option", "-p", "-t", pane, opt, val];
}
export function sendKeysLiteralArgs(pane: string, line: string): string[] {
  return ["send-keys", "-t", pane, "-l", line];
}
export function sendKeysEnterArgs(pane: string): string[] {
  return ["send-keys", "-t", pane, "Enter"];
}
export function wrapLaunch(launch: string, hasBashrc: boolean = existsSync(join(homedir(), ".bashrc"))): string {
  return hasBashrc ? `bash -ic 'exec ${launch}'` : launch;
}
export function sentinelCommand(labelFmt: string): string {
  // printf the colored label + reserved notice, then hold the pane open.
  return `printf '%s\\n  preflight pane reserved — awaiting spawn...\\n' ${JSON.stringify(labelFmt)}; sleep infinity`;
}

// ---------- execa wrappers (live tmux) ----------
async function tmux(args: string[]): Promise<string> {
  const { stdout } = await execa("tmux", args);
  return stdout.trim();
}
export const splitRight = (launch: string, target?: string, cwd?: string) => tmux(splitRightArgs(launch, target, cwd));
export const splitDown = (launch: string, target: string, cwd?: string) => tmux(splitDownArgs(launch, target, cwd));
export const respawn = (pane: string, launch: string, cwd?: string) => tmux(respawnArgs(pane, launch, cwd));

export async function setOption(pane: string, opt: string, val: string): Promise<void> { await tmux(setOptionArgs(pane, opt, val)); }

export async function paneAlive(pane: string): Promise<boolean> {
  const { stdout } = await execa("tmux", ["list-panes", "-a", "-F", "#{pane_id}"]);
  return stdout.split("\n").includes(pane);
}

export async function paneSend(pane: string, line: string): Promise<void> {
  await execa("tmux", sendKeysLiteralArgs(pane, line));
  await new Promise((r) => setTimeout(r, 300)); // load-bearing beat before Enter
  await execa("tmux", sendKeysEnterArgs(pane));
}

export async function capturePane(pane: string, lines?: number): Promise<string> {
  try {
    const { stdout } = await execa("tmux", ["capture-pane", "-p", "-t", pane]);
    return lines ? stdout.split("\n").slice(-lines).join("\n") : stdout;
  } catch { return ""; }
}

export async function killNow(pane: string): Promise<void> {
  try { await execa("tmux", ["kill-pane", "-t", pane]); } catch { /* tolerate */ }
}

export async function selectLayoutMainVertical(target: string): Promise<void> {
  await execa("tmux", ["select-layout", "-t", target, "main-vertical"]);
}

export async function conductorPane(): Promise<string> {
  if (process.env.TMUX_PANE) return process.env.TMUX_PANE;
  return tmux(["display-message", "-p", "#{pane_id}"]);
}
