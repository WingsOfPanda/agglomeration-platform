// Morandi 256-color palette (values carried over verbatim from the prior bash lib/colors.sh),
// keyed to NATO-phonetic agents grouped into color clusters. Each cluster has a distinct
// color family so concurrently-spawned agents are visually grouped on their pane borders.
type Cluster = "azure" | "sage" | "amber" | "slate" | "ivory" | "violet" | "neutral";

interface Entry { cluster: Cluster; primary: string; secondary: string; }

const PALETTE: Record<string, Entry> = {
  // azure — cool dusty blues/slate
  alpha:    { cluster: "azure", primary: "colour109", secondary: "colour187" },
  bravo:    { cluster: "azure", primary: "colour110", secondary: "colour187" },
  charlie:  { cluster: "azure", primary: "colour67",  secondary: "colour187" },
  delta:    { cluster: "azure", primary: "colour103", secondary: "colour187" },
  echo:     { cluster: "azure", primary: "colour60",  secondary: "colour250" },
  // sage — sage/olive earth tones
  foxtrot:  { cluster: "sage", primary: "colour108", secondary: "colour144" },
  golf:     { cluster: "sage", primary: "colour100", secondary: "colour137" },
  hotel:    { cluster: "sage", primary: "colour95",  secondary: "colour241" },
  india:    { cluster: "sage", primary: "colour101", secondary: "colour241" },
  juliet:   { cluster: "sage", primary: "colour144", secondary: "colour247" },
  kilo:     { cluster: "sage", primary: "colour152", secondary: "colour187" },
  // amber — terracotta/warm
  lima:     { cluster: "amber", primary: "colour173", secondary: "colour144" },
  mike:     { cluster: "amber", primary: "colour137", secondary: "colour187" },
  november: { cluster: "amber", primary: "colour180", secondary: "colour247" },
  oscar:    { cluster: "amber", primary: "colour131", secondary: "colour110" },
  papa:     { cluster: "amber", primary: "colour223", secondary: "colour174" },
  // slate — neutral greys
  quebec:   { cluster: "slate", primary: "colour102", secondary: "colour247" },
  romeo:    { cluster: "slate", primary: "colour245", secondary: "colour187" },
  sierra:   { cluster: "slate", primary: "colour243", secondary: "colour250" },
  tango:    { cluster: "slate", primary: "colour96",  secondary: "colour250" },
  uniform:  { cluster: "slate", primary: "colour250", secondary: "colour241" },
  // ivory — cream/beige
  victor:   { cluster: "ivory", primary: "colour187", secondary: "colour250" },
  whiskey:  { cluster: "ivory", primary: "colour181", secondary: "colour250" },
  xray:     { cluster: "ivory", primary: "colour146", secondary: "colour250" },
  // violet — mauve/plum
  yankee:   { cluster: "violet", primary: "colour139", secondary: "colour241" },
  zulu:     { cluster: "violet", primary: "colour132", secondary: "colour137" },
};

const FALLBACK: Entry = { cluster: "neutral", primary: "white", secondary: "default" };
function entry(agent: string): Entry { return PALETTE[agent.toLowerCase()] ?? FALLBACK; }
function isClustered(agent: string): boolean { return agent.toLowerCase() in PALETTE; }

export function clusterFor(agent: string): Cluster { return entry(agent).cluster; }
export function colorFor(agent: string): string { return entry(agent).primary; }

export function labelFor(agent: string, model: string, topic: string): string {
  const sec = clusterFor(agent);
  const head = isClustered(agent) ? `${sec}-${agent}` : sec;
  return `${head}:${model}:${topic}`;
}

export function labelFmt(agent: string, model: string, topic: string): string {
  const e = entry(agent);
  const head = isClustered(agent)
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
