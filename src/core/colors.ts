// Morandi 256-color palette (values carried over verbatim from the prior bash lib/colors.sh),
// re-keyed to agents grouped by orchestral cluster for harmony.
type Cluster = "strings" | "woodwinds" | "brass" | "percussion" | "keys" | "early" | "tutti";

interface Entry { cluster: Cluster; primary: string; secondary: string; }

const PALETTE: Record<string, Entry> = {
  // strings — cool dusty blues/slate
  violin:     { cluster: "strings", primary: "colour110", secondary: "colour187" },
  viola:      { cluster: "strings", primary: "colour109", secondary: "colour187" },
  cello:      { cluster: "strings", primary: "colour67",  secondary: "colour187" },
  contrabass: { cluster: "strings", primary: "colour60",  secondary: "colour250" },
  harp:       { cluster: "strings", primary: "colour103", secondary: "colour187" },
  // woodwinds — sage/olive earth tones
  flute:      { cluster: "woodwinds", primary: "colour108", secondary: "colour144" },
  piccolo:    { cluster: "woodwinds", primary: "colour144", secondary: "colour247" },
  oboe:       { cluster: "woodwinds", primary: "colour100", secondary: "colour137" },
  clarinet:   { cluster: "woodwinds", primary: "colour101", secondary: "colour241" },
  bassoon:    { cluster: "woodwinds", primary: "colour95",  secondary: "colour241" },
  recorder:   { cluster: "woodwinds", primary: "colour152", secondary: "colour187" },
  // brass — terracotta/warm
  horn:       { cluster: "brass", primary: "colour137", secondary: "colour187" },
  trumpet:    { cluster: "brass", primary: "colour173", secondary: "colour144" },
  trombone:   { cluster: "brass", primary: "colour180", secondary: "colour247" },
  tuba:       { cluster: "brass", primary: "colour131", secondary: "colour110" },
  cornet:     { cluster: "brass", primary: "colour223", secondary: "colour174" },
  // percussion — neutral greys
  timpani:    { cluster: "percussion", primary: "colour102", secondary: "colour247" },
  celesta:    { cluster: "percussion", primary: "colour245", secondary: "colour187" },
  vibraphone: { cluster: "percussion", primary: "colour243", secondary: "colour250" },
  marimba:    { cluster: "percussion", primary: "colour96",  secondary: "colour250" },
  xylophone:  { cluster: "percussion", primary: "colour250", secondary: "colour241" },
  glockenspiel: { cluster: "percussion", primary: "colour247", secondary: "colour250" },
  // keys — cream/beige
  piano:      { cluster: "keys", primary: "colour187", secondary: "colour250" },
  organ:      { cluster: "keys", primary: "colour181", secondary: "colour250" },
  harpsichord: { cluster: "keys", primary: "colour146", secondary: "colour250" },
  // early — mauve/plum
  lute:       { cluster: "early", primary: "colour139", secondary: "colour241" },
  theorbo:    { cluster: "early", primary: "colour97",  secondary: "colour187" },
  viol:       { cluster: "early", primary: "colour132", secondary: "colour137" },
  sackbut:    { cluster: "early", primary: "colour138", secondary: "colour241" },
  shawm:      { cluster: "early", primary: "colour174", secondary: "colour250" },
  crumhorn:   { cluster: "early", primary: "colour182", secondary: "colour250" },
  cittern:    { cluster: "early", primary: "colour218", secondary: "colour250" },
};

const FALLBACK: Entry = { cluster: "tutti", primary: "white", secondary: "default" };
function entry(agent: string): Entry { return PALETTE[agent.toLowerCase()] ?? FALLBACK; }
function isOrchestral(agent: string): boolean { return agent.toLowerCase() in PALETTE; }

export function clusterFor(agent: string): Cluster { return entry(agent).cluster; }
export function colorFor(agent: string): string { return entry(agent).primary; }

export function labelFor(agent: string, model: string, topic: string): string {
  const sec = clusterFor(agent);
  const head = isOrchestral(agent) ? `${sec}-${agent}` : sec;
  return `${head}:${model}:${topic}`;
}

export function labelFmt(agent: string, model: string, topic: string): string {
  const e = entry(agent);
  const head = isOrchestral(agent)
    ? `#[fg=${e.primary},bold]${e.cluster}-${agent}#[default]`
    : `#[fg=${e.primary},bold]${e.cluster}#[default]`;
  return `${head}:#[fg=${e.secondary},bold]${model}#[default]:${topic}`;
}

export function ansiFromColor(color: string): string {
  const m = /^colour([0-9]+)$/.exec(color);
  if (m) return `\x1b[38;5;${m[1]}m`;
  if (/^[0-9]+$/.test(color)) return `\x1b[38;5;${color}m`;
  return "";
}

const RULE = "━".repeat(43);
export function renderBannerHead(label: string, color: string): string {
  const c = ansiFromColor(color), r = "\x1b[0m", b = "\x1b[1m";
  return [
    "",
    `  ${c}${RULE}${r}`,
    `  ${b}${c}${label || "worker"}${r}`,
    `  ${c}DONE — pane closing${r}`,
    `  ${c}${RULE}${r}`,
    "",
  ].join("\n");
}
