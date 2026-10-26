import type { Template } from "./types.ts";

/** Single-file components: the script part is parsed as TypeScript, the markup is scanned for tags and links. */
export const EMBED_EXT = /\.(vue|svelte|astro)$/;

const blank = (s: string) => s.replace(/[^\n]/g, " ");

/** Splits a .vue/.svelte/.astro file into script code and template, both the same length as the file so offsets and lines stay right. */
export function splitComponent(file: string, text: string): { code: string; tsx: boolean; template: Template; name: string } {
  const ranges: [number, number][] = [];
  let tsx = false;
  if (file.endsWith(".astro")) {
    const m = /^\s*---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (m) {
      const start = m.index + m[0].indexOf(m[1]);
      ranges.push([start, start + m[1].length]);
    }
  }
  for (const m of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (/\bsrc\s*=|type\s*=\s*["'](?:application\/(?:ld\+)?json|text\/template)/.test(m[1])) continue;
    if (/lang\s*=\s*["']?(tsx|jsx)/.test(m[1])) tsx = true;
    const start = m.index! + m[0].indexOf(">") + 1;
    ranges.push([start, start + m[2].length]);
  }
  let code = "";
  let template = "";
  let at = 0;
  for (const [s, e] of ranges.sort((a, b) => a[0] - b[0])) {
    code += blank(text.slice(at, s)) + text.slice(s, e);
    template += text.slice(at, s) + blank(text.slice(s, e));
    at = e;
  }
  code += blank(text.slice(at));
  template += text.slice(at);

  const newlines: number[] = [];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) newlines.push(i);
  const line = (offset: number) => {
    let lo = 0, hi = newlines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (newlines[mid] < offset) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  };
  return { code, tsx, template: { text: template, line }, name: componentName(file) };
}

/** user-profile.vue → UserProfile; routes/blog/[slug]/+page.svelte → blog/[slug]/+page */
export function componentName(file: string): string {
  const parts = file.replace(/\.[^./]+$/, "").split("/");
  const base = parts.pop()!;
  if (/^(\+|_|index$|page$|layout$|\[)/.test(base)) return [...parts.slice(-2), base].join("/");
  return base.replace(/(^|[-_.\s])(\w)/g, (_, __, c: string) => c.toUpperCase());
}
