export interface DiscoveredSource {
  url: string;
  label: string;
}

interface Anchor {
  url: string;
  label: string;
  official: boolean;
}

export function discoverSovcUrl(html: string, pageUrl: string): DiscoveredSource | null {
  const section = generalSection(html);
  if (!section) return null;
  const anchors = collectAnchors(section, pageUrl).filter((anchor) =>
    /statement of votes cast/i.test(anchor.label),
  );
  if (anchors.length === 0) return null;
  const official = anchors.filter((anchor) => anchor.official);
  const pool = official.length > 0 ? official : anchors;
  const selected = pool[pool.length - 1];
  return { url: selected.url, label: selected.label };
}

function generalSection(html: string): string {
  const start = html.search(/<h3[^>]*>\s*General Election/i);
  if (start < 0) return "";
  const rest = html.slice(start);
  const end = rest.search(/<h3[^>]*>\s*Primary Election/i);
  return end < 0 ? rest : rest.slice(0, end);
}

function collectAnchors(html: string, pageUrl: string): Anchor[] {
  const anchors: Anchor[] = [];
  const pattern = /<a\b([^>]*?)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(pattern)) {
    const href = readHref(match[1] ?? "");
    const label = stripTags(match[2] ?? "");
    if (!href || !label) continue;
    let url: string;
    try {
      url = new URL(href, pageUrl).href;
    } catch {
      continue;
    }
    if (!url.startsWith("https://")) continue;
    const official = /official/i.test(label) && !/unofficial/i.test(label);
    anchors.push({ url, label, official });
  }
  return anchors;
}

function readHref(attributes: string): string | null {
  const match = attributes.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  const href = match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
  if (!href || href.startsWith("#") || href.startsWith("javascript:")) return null;
  return href;
}

function stripTags(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}
