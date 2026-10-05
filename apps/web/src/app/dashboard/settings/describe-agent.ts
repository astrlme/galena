// Order matters: Edge's agent also names Chrome and Safari, Chrome's names Safari, an iPhone's
// says "like Mac OS X", and Android's says Linux.
const BROWSERS: [RegExp, string][] = [
  [/Edg(e|A|iOS)?\//, "Edge"],
  [/Firefox\/|FxiOS\//, "Firefox"],
  [/Chrome\/|CriOS\//, "Chrome"],
  [/Safari\//, "Safari"],
];
const SYSTEMS: [RegExp, string][] = [
  [/iPhone/, "iPhone"],
  [/iPad/, "iPad"],
  [/Android/, "Android"],
  [/Windows/, "Windows"],
  [/Mac OS X|Macintosh/, "macOS"],
  [/Linux/, "Linux"],
];

const first = (agent: string, list: [RegExp, string][]) =>
  list.find(([pattern]) => pattern.test(agent))?.[1];

/** "Chrome on Windows": enough to tell your own sessions apart. */
export function describeAgent(agent: string | null | undefined): string {
  const browser = agent ? first(agent, BROWSERS) : undefined;
  if (!agent || !browser) return "Unknown browser";
  const system = first(agent, SYSTEMS);
  return system ? `${browser} on ${system}` : browser;
}
