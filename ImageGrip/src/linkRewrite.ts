export interface EmbedSpan {
  start: number;
  end: number;
  text: string;
}

export interface WidthEdit {
  startCh: number;
  endCh: number;
  newText: string;
}

const WIKI_EMBED = /!\[\[[^\]]+\]\]/g;
const MD_EMBED = /!\[[^\]]*\]\([^)]+\)/g;
const SIZE_SEGMENT = /^\d+(x\d+)?$/;

function findEmbeds(lineText: string): EmbedSpan[] {
  const spans: EmbedSpan[] = [];
  for (const re of [WIKI_EMBED, MD_EMBED]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(lineText)) !== null) {
      const start = m.index;
      const end = m.index + m[0].length;
      // wiki matches are collected first; skip a markdown match overlapping one
      if (!spans.some((s) => start < s.end && end > s.start)) {
        spans.push({ start, end, text: m[0] });
      }
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

export function findEmbedAt(lineText: string, ch: number): EmbedSpan | null {
  return findEmbeds(lineText).find((s) => ch >= s.start && ch <= s.end) ?? null;
}

function applySizeToSegments(
  segments: string[],
  width: number,
  firstIsTarget: boolean
): string[] {
  const lastIndex = segments.length - 1;
  const minSizeIndex = firstIsTarget ? 1 : 0;
  if (lastIndex >= minSizeIndex && SIZE_SEGMENT.test(segments[lastIndex])) {
    return [...segments.slice(0, -1), String(width)];
  }
  return [...segments, String(width)];
}

export function rewriteWidth(embedText: string, width: number): string {
  const wiki = embedText.match(/^!\[\[([^\]]+)\]\]$/);
  if (wiki) {
    const segments = applySizeToSegments(wiki[1].split("|"), width, true);
    return `![[${segments.join("|")}]]`;
  }
  const md = embedText.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
  if (md) {
    const altSegments = md[1] === "" ? [] : md[1].split("|");
    const segments = applySizeToSegments(altSegments, width, false);
    return `![${segments.join("|")}](${md[2]})`;
  }
  return embedText;
}

export function applyWidth(
  lineText: string,
  ch: number,
  width: number,
  targetHint?: string
): WidthEdit | null {
  const candidates = findEmbeds(lineText).filter(
    (s) => ch >= s.start && ch <= s.end
  );
  const embed =
    (targetHint && candidates.find((s) => s.text.includes(targetHint))) ??
    candidates[0] ??
    null;
  if (!embed) return null;
  return {
    startCh: embed.start,
    endCh: embed.end,
    newText: rewriteWidth(embed.text, width),
  };
}
