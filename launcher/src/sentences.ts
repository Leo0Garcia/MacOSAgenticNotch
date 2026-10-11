// Cuts streamed text into speakable sentences as soon as each one is complete,
// so the first sentence is spoken while the rest is still being written.

const ABBREVIATIONS = new Set(["mr", "mrs", "ms", "dr", "st", "prof", "vs", "etc", "e.g", "i.e", "approx", "no"]);

export class SentenceSplitter {
  private buf = "";

  /** Adds streamed text and returns every sentence it completed. */
  push(text: string): string[] {
    this.buf += text;
    const out: string[] = [];
    let start = 0;
    for (let i = 0; i < this.buf.length; i++) {
      const ch = this.buf[i];
      if (ch === "\n") {
        // Line breaks end list items and paragraphs: speak what came before.
        const s = this.buf.slice(start, i);
        if (s.trim()) out.push(s);
        start = i + 1;
        continue;
      }
      if (ch !== "." && ch !== "!" && ch !== "?" && ch !== "…") continue;
      let j = i + 1;
      while (j < this.buf.length && /["'”’)\]*_]/.test(this.buf[j])) j++;
      if (j >= this.buf.length) break; // can't tell yet: wait for more text
      if (!/\s/.test(this.buf[j])) continue; // 3.5, example.com, e.g.
      if (ch === "." && this.isAbbreviation(start, i)) continue;
      const s = this.buf.slice(start, j);
      if (s.trim()) out.push(s);
      start = j;
      i = j - 1;
    }
    this.buf = this.buf.slice(start);
    return out.map(speakable).filter(Boolean);
  }

  /** Returns whatever is left, e.g. a reply that doesn't end in punctuation. */
  flush(): string[] {
    const s = speakable(this.buf);
    this.buf = "";
    return s ? [s] : [];
  }

  private isAbbreviation(start: number, dot: number): boolean {
    const word = /([A-Za-z.]+)$/.exec(this.buf.slice(start, dot))?.[1]?.toLowerCase() ?? "";
    return ABBREVIATIONS.has(word);
  }
}

/** Strips markdown so `say` doesn't read out asterisks and link targets. */
export function speakable(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/(\*\*|__|\*|_|~~)(\S[^]*?\S|\S)\1/g, "$2")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
