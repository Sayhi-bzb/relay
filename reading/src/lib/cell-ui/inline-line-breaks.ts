type Ink = Readonly<{ text: string; width: number; atomic?: boolean }>;
type Line = Readonly<{ start: number; end: number }>;

const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const word = /[\p{L}\p{M}\p{N}_]/u;
const whitespace = /^\s+$/u;
const opening = /^[([{（【《「『〔［｛〈“‘]/u;
const closing = /^[,.;:!?\])}，。；：！？、）】》」』〕］｝〉”’％…]/u;
const isSpace = (ink: Ink) => !ink.atomic && whitespace.test(ink.text);
const isWord = (ink: Ink) => !ink.atomic && word.test(ink.text) && !cjk.test(ink.text);
const opens = (ink: Ink) => !ink.atomic && opening.test(ink.text);
const closes = (ink: Ink) => !ink.atomic && closing.test(ink.text);

export function layoutInlineLines(ink: readonly Ink[], limit: number, preserveLeading = false): Line[] {
  const lines: Line[] = [];
  let start = 0;
  let end = 0;
  let width = 0;
  let gap = 0;
  const finish = (next: number) => {
    lines.push({ start, end });
    start = end = next;
    width = gap = 0;
  };
  for (let index = 0; index < ink.length;) {
    const first = index;
    if (isSpace(ink[index]!)) {
      while (index < ink.length && isSpace(ink[index]!)) gap += ink[index++]!.width;
      if (!width && (first !== 0 || !preserveLeading)) {
        start = end = index;
        gap = 0;
      }
      continue;
    }
    while (index + 1 < ink.length && opens(ink[index]!) && !isSpace(ink[index + 1]!)) index++;
    const wordStart = index;
    let wordWidth = 0;
    if (isWord(ink[index]!)) {
      while (index < ink.length && isWord(ink[index]!)) wordWidth += ink[index++]!.width;
    } else {
      index++;
    }
    const wordEnd = index;
    while (index < ink.length && closes(ink[index]!)) index++;
    let unitWidth = 0;
    for (let i = first; i < index; i++) unitWidth += ink[i]!.width;

    if (width && width + gap + unitWidth > limit) finish(first);
    if (!width && gap && gap + unitWidth > limit) {
      start = end = first;
      gap = 0;
    }
    width += gap;
    gap = 0;
    for (let i = first; i < index; i++) {
      const cell = ink[i]!;
      if (i === wordStart && wordWidth && wordWidth <= limit) {
        if (width && width + wordWidth > limit) finish(i);
        width += wordWidth;
        end = wordEnd;
        i = wordEnd - 1;
        continue;
      }
      const next = i + 1 < index ? ink[i + 1] : undefined;
      const pair = next && (opens(cell) || closes(next)) ? cell.width + next.width : cell.width;
      const keep = pair <= limit ? pair : cell.width;
      if (width && width + keep > limit) finish(i);
      width += cell.width;
      end = i + 1;
    }
  }
  return [...lines, { start, end }];
}
