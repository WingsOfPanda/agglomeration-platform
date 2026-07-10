import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { pluginRoot } from "./paths.js";

export function contractsPath(): string {
  return join(pluginRoot(), "config", "contracts.yaml");
}

export interface Agent {
  binary?: string;
  modes?: Record<string, string[]>;
  default_mode?: string;
  ready_timeout_s?: number;
  bootstrap_sleep_s?: number;
  timeout_multiplier?: unknown;
  consult_validated?: boolean;
}
type Doc = Record<string, any>;

function load(): Doc {
  const p = contractsPath();
  if (!existsSync(p)) return {};
  try { return (parse(readFileSync(p, "utf8")) as Doc) ?? {}; } catch { return {}; }
}

export function listAgents(): string[] {
  return Object.keys(load()).filter((k) => k !== "consult");
}
function inst(name: string): Agent | undefined {
  const d = load(); return name !== "consult" ? (d[name] as Agent) : undefined;
}

export function agentBinary(name: string): string | undefined { return inst(name)?.binary || undefined; }
export function agentDefaultMode(name: string): string | undefined { return inst(name)?.default_mode || undefined; }
export function agentModeArgs(name: string, mode: string): string[] | undefined {
  const m = inst(name)?.modes?.[mode];
  return Array.isArray(m) ? m.map(String) : undefined;
}
export function agentReadyTimeout(name: string): number {
  const v = inst(name)?.ready_timeout_s;
  return typeof v === "number" ? v : 30;
}
export function agentBootstrapSleep(name: string): number {
  const v = inst(name)?.bootstrap_sleep_s;
  if (typeof v === "number") return v;
  return name === "claude" ? 12 : 8;
}
export function agentTimeoutMultiplier(name: string): string {
  const raw = inst(name)?.timeout_multiplier;
  const s = raw == null ? "" : String(raw);
  if (/^[0-9]+(\.[0-9]+)?$/.test(s) && Number(s) > 0) return s;
  return "1.0";
}
export function agentConsultValidated(name: string): boolean {
  if (!name) throw new TypeError("agentConsultValidated: missing provider arg");
  return inst(name)?.consult_validated === true;
}

export type ConsultKind = "research" | "verify" | "adversary" | "experiment" | "openq" | "rebuttal" | "gap";
const CONSULT_DEFAULTS: Record<ConsultKind, number> = { research: 600, verify: 300, adversary: 600, experiment: 1800, openq: 300, rebuttal: 300, gap: 600 };
export function consultTimeout(kind: ConsultKind): number {
  if (!(kind in CONSULT_DEFAULTS)) throw new Error(`consultTimeout: kind must be 'research', 'verify', 'adversary', 'experiment', 'openq', 'rebuttal', or 'gap'; got '${kind}'`);
  const v = (load().consult ?? {})[`${kind}_timeout_s`];
  return /^[1-9][0-9]*$/.test(String(v)) ? Number(v) : CONSULT_DEFAULTS[kind];
}

export function contractsExist(): boolean { return existsSync(contractsPath()); }
