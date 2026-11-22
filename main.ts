// mend: one patch tool for every AI edit format.
//
// A model writes an edit in one of four shapes -- a unified diff, SEARCH/REPLACE
// blocks, a V4A patch, or JSON tool calls -- and mend reads it, finds the lines
// each edit names (exact, then trailing-whitespace, then full-trim matching),
// and writes every change or none at all. Node 22, standard library only; run
// as `node main.ts [options] [PATCH]` with the working directory as the tree
// root. SPEC.md is the whole contract; this file is its implementation.
//
// When MAKEFUN_ENV_URL is set the file hands the trial over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 answer: one line of stdout, nothing written. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit that failed, with the code and path its error line names. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed each, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines, its own line break, and whether it ends with one. */
interface Doc {
  br: string;
  lines: string[];
  final: boolean;
}

function splitDoc(text: string): Doc {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.final ? d.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** What the patch format is, from its text (SPEC.md section 4). */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Line matching (SPEC.md section 5)
// ---------------------------------------------------------------------------

/** The key a line is compared by at a tier: itself, trailing spaces/tabs off, or both ends off. */
function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  const t = line.replace(/[ \t]+$/, '');
  return tier === 1 ? t : t.replace(/^[ \t]+/, '');
}

/** Positions at or after `from` where `old` matches `lines` at `tier`; occurrences may overlap. */
function occurrences(lines: string[], old: string[], tier: number, from: number): number[] {
  const want = old.map((l) => tierKey(l, tier));
  const hits: number[] = [];
  for (let i = from; i + old.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < old.length; j++) {
      if (tierKey(lines[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  return hits;
}

/** The first tier (0, then 1, then 2; only 0 with --strict) at which `old` occurs at or after
 *  `from`, and its first occurrence there. With `eof` only occurrences ending at the file's
 *  last line count. Null when no tier has one. */
function firstHit(lines: string[], old: string[], from: number, strict: boolean, eof: boolean): { tier: number; at: number } | null {
  const top = strict ? 0 : 2;
  for (let tier = 0; tier <= top; tier++) {
    const hits = occurrences(lines, old, tier, from).filter((i) => !eof || i + old.length === lines.length);
    if (hits.length > 0) return { tier, at: hits[0]! };
  }
  return null;
}

/** One line of a replacement side: a context line (its index into O) or a fresh line. */
interface NewLine {
  text: string;
  ctx: number | null;
}

/** What N becomes in the file. A context line is written as the file's own matched line, never
 *  the patch's. At tier 2 every other line is re-indented: its leading spaces/tabs of O's first
 *  line are swapped for those of the file's first matched line, when it starts with them. */
function buildNew(nlines: NewLine[], file: string[], at: number, tier: number, oldFirst: string): string[] {
  const fLead = /^[ \t]*/.exec(file[at]!)![0]!;
  const pLead = /^[ \t]*/.exec(oldFirst)![0]!;
  return nlines.map((nl) => {
    if (nl.ctx !== null) return file[at + nl.ctx]!;
    if (tier !== 2) return nl.text;
    const t = nl.text;
    if (t === '' || /^[ \t]+$/.test(t)) return t;
    return t.startsWith(pLead) ? fLead + t.slice(pLead.length) : t;
  });
}

/** Apply hunks to a file's lines in place. `failPath` is the path a no-match names. */
function applyHunks(doc: Doc, hunks: Hunk[], strict: boolean, failPath: string): void {
  let d = 0;
  for (const h of hunks) {
    const O = h.oldLines;
    const N = h.newLines;
    if (O.length === 0) {
      const before = doc.lines.length;
      const at = Math.max(0, Math.min(h.a + d, before));
      const ins = N.map((nl) => nl.text);
      doc.lines.splice(at, 0, ...ins);
      if (at === before) doc.final = !h.noBreak;
      d += ins.length;
      continue;
    }
    const top = strict ? 0 : 2;
    let hit: { tier: number; at: number } | null = null;
    for (let tier = 0; tier <= top; tier++) {
      const occ = occurrences(doc.lines, O, tier, 0);
      if (occ.length === 0) continue;
      const target = h.a - 1 + d;
      let best = occ[0]!;
      for (const o of occ) {
        if (Math.abs(o - target) < Math.abs(best - target)) best = o;
      }
      hit = { tier, at: best };
      break;
    }
    if (hit === null) throw new Fail('no-match', failPath);
    const toEnd = hit.at + O.length === doc.lines.length;
    const outs = buildNew(N, doc.lines, hit.at, hit.tier, O[0]!);
    doc.lines.splice(hit.at, O.length, ...outs);
    if (toEnd) doc.final = !h.noBreak;
    d += outs.length - O.length;
  }
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  /** Old start, 1-based, from the header. */
  a: number;
  oldLines: string[];
  newLines: NewLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noBreak: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  plusNoBreak: boolean;
}

interface Section {
  oldPath: string | null; // null: /dev/null, no file
  newPath: string | null;
  pairSeen: boolean;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** A `--- ` / `+++ ` path: text after the four characters, up to the first tab, trimmed, one a//b/ off. */
function headerPath(line: string): string {
  const p = line.slice(4).split('\t')[0]!.trim();
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

function pathOrNull(p: string): string | null {
  return p === '/dev/null' ? null : p;
}

/** Read one hunk (header at `i`) into the section; return the index after its body. */
function readHunk(lines: string[], i: number, a: number, sec: Section): number {
  const n = lines.length;
  i += 1;
  const body: Array<{ k: string; t: string }> = [];
  while (i < n) {
    const l = lines[i]!;
    if (l === '') {
      body.push({ k: '', t: '' });
      i += 1;
      continue;
    }
    const c = l[0]!;
    if (c === ' ' || c === '-' || c === '+' || c === '\\') {
      if (c === '-' && l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
      body.push({ k: c, t: l.slice(1) });
      i += 1;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1]!.k === '') body.pop();
  const oldLines: string[] = [];
  const newLines: NewLine[] = [];
  for (const b of body) {
    if (b.k === ' ' || b.k === '') {
      oldLines.push(b.t);
      newLines.push({ text: b.t, ctx: oldLines.length - 1 });
    } else if (b.k === '-') {
      oldLines.push(b.t);
    } else if (b.k === '+') {
      newLines.push({ text: b.t, ctx: null });
    }
  }
  const followsBackslash = (pred: (b: { k: string; t: string }) => boolean): boolean => {
    for (let j = body.length - 1; j >= 0; j--) {
      if (pred(body[j]!)) return body[j + 1] !== undefined && body[j + 1]!.k === '\\';
    }
    return false;
  };
  sec.hunks.push({
    a,
    oldLines,
    newLines,
    noBreak: followsBackslash((b) => b.k === ' ' || b.k === '' || b.k === '+'),
    plusNoBreak: followsBackslash((b) => b.k === '+'),
  });
  return i;
}

/** Split the patch into sections. Lines outside bodies that are not part of a section header are
 *  ignored (prose, code fences), so a hunk after such lines still belongs to the section in
 *  progress; only a hunk before any section has started is a parse error. */
function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  const n = lines.length;
  let i = 0;
  let cur: Section | null = null;
  let inHeader = false;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldPath: m[1]!, newPath: m[2]!, pairSeen: false, newFile: false, delFile: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && !cur.pairSeen) {
        cur.oldPath = pathOrNull(headerPath(l));
        cur.newPath = pathOrNull(headerPath(lines[i + 1]!));
        cur.pairSeen = true;
        i += 2;
        continue;
      }
      cur = { oldPath: null, newPath: null, pairSeen: true, newFile: false, delFile: false, hunks: [] };
      cur.oldPath = pathOrNull(headerPath(l));
      cur.newPath = pathOrNull(headerPath(lines[i + 1]!));
      sections.push(cur);
      inHeader = true;
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_HEAD.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      i = readHunk(lines, i, Number(m[1]), cur);
      inHeader = false;
      continue;
    }
    if (cur === null || !inHeader) {
      i += 1;
      continue;
    }
    if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
    if (l.startsWith('rename from ')) {
      if (!cur.pairSeen) cur.oldPath = pathOrNull(l.slice('rename from '.length).trim());
      i += 1;
      continue;
    }
    if (l.startsWith('rename to ')) {
      if (!cur.pairSeen) cur.newPath = pathOrNull(l.slice('rename to '.length).trim());
      i += 1;
      continue;
    }
    if (l.startsWith('new file mode')) {
      cur.newFile = true;
      i += 1;
      continue;
    }
    if (l.startsWith('deleted file mode')) {
      cur.delFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections;
}

/** One edit per section, in the patch's order. */
function unifiedEdits(sections: Section[], strict: boolean, moves: Array<[string, string]>): Edit[] {
  return sections.map((sec) => {
    const kind = sec.oldPath === null || sec.newFile ? 'create' : sec.newPath === null || sec.delFile ? 'delete' : sec.oldPath !== sec.newPath ? 'move' : 'change';
    return (tree: Tree): void => {
      if (sec.oldPath !== null && !safe(sec.oldPath)) throw new Fail('unsafe', sec.oldPath);
      if (sec.newPath !== null && !safe(sec.newPath)) throw new Fail('unsafe', sec.newPath);
      if (kind === 'create') {
        const p = sec.newPath;
        if (p === null) throw new Fail('unsafe', '/dev/null');
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const plus: string[] = [];
        let lastPlusNoBreak = false;
        let anyPlus = false;
        for (const h of sec.hunks) {
          let hasPlus = false;
          for (const nl of h.newLines) {
            if (nl.ctx === null) {
              plus.push(nl.text);
              hasPlus = true;
            }
          }
          if (hasPlus) {
            anyPlus = true;
            lastPlusNoBreak = h.plusNoBreak;
          }
        }
        tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (anyPlus && lastPlusNoBreak ? '' : '\n'));
        return;
      }
      if (kind === 'delete') {
        const p = sec.oldPath;
        if (p === null) throw new Fail('unsafe', '/dev/null');
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
        return;
      }
      if (kind === 'move') {
        const from = sec.oldPath!;
        const to = sec.newPath!;
        if (tree.get(from) === null) throw new Fail('missing', from);
        if (tree.get(to) !== null) throw new Fail('exists', to);
        const doc = splitDoc(tree.get(from)!);
        applyHunks(doc, sec.hunks, strict, from);
        tree.now.set(to, joinDoc(doc));
        tree.now.set(from, null);
        moves.push([from, to]);
        return;
      }
      const p = sec.oldPath!;
      if (tree.get(p) === null) throw new Fail('missing', p);
      const doc = splitDoc(tree.get(p)!);
      applyHunks(doc, sec.hunks, strict, p);
      tree.now.set(p, joinDoc(doc));
    };
  });
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree: Tree): void => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const doc = splitDoc(cur);
    const hit = firstHit(doc.lines, oldLines, 0, strict, false);
    if (hit === null) throw new Fail('no-match', path);
    if (occurrences(doc.lines, oldLines, hit.tier, 0).length > 1) throw new Fail('ambiguous', path);
    const outs = buildNew(
      newLines.map((t) => ({ text: t, ctx: null })),
      doc.lines,
      hit.at,
      hit.tier,
      oldLines[0]!,
    );
    doc.lines.splice(hit.at, oldLines.length, ...outs);
    tree.now.set(path, joinDoc(doc));
  };
}

/** Split the patch into blocks. A block's path is the nearest usable line before its SEARCH line. */
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l) || l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let sep = -1;
    let j = s + 1;
    for (; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        sep = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') throw new Exit2(`error: parse ${s + 1}`);
    }
    if (sep < 0) throw new Exit2(`error: parse ${s + 1}`);
    let end = -1;
    for (j = sep + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${s + 1}`);
    edits.push(searchReplaceEdit(path, lines.slice(s + 1, sep), lines.slice(sep + 1, end), strict));
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface Chunk {
  anchor: string | null;
  eof: boolean;
  oldLines: string[];
  newLines: NewLine[];
}

/** One V4A section's raw lines, each with its 1-based patch line number. */
interface RawLine {
  text: string;
  no: number;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree: Tree): void => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree: Tree): void => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, raw: RawLine[], headLine: number, strict: boolean, moves: Array<[string, string]>): Edit {
  let moveTo: string | null = null;
  let idx = 0;
  if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: Chunk[] = [];
  let cur: Chunk | null = null;
  const open = (anchor: string | null): void => {
    cur = { anchor, eof: false, oldLines: [], newLines: [] };
    chunks.push(cur);
  };
  for (; idx < raw.length; idx++) {
    const r = raw[idx]!;
    const t = r.text;
    if (t.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${r.no}`);
    if (t === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${r.no}`);
      cur.eof = true;
      cur = null;
      continue;
    }
    if (t.startsWith('@@')) {
      const anchor = t.slice(2).trim();
      open(anchor === '' ? null : anchor);
      continue;
    }
    if (t.startsWith('*** ')) throw new Exit2(`error: parse ${r.no}`);
    if (t === '' || t.startsWith(' ') || t.startsWith('-') || t.startsWith('+')) {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${r.no}`);
        open(null);
      }
      if (t === '') {
        cur!.oldLines.push('');
        cur!.newLines.push({ text: '', ctx: cur!.oldLines.length - 1 });
      } else if (t[0] === ' ') {
        cur!.oldLines.push(t.slice(1));
        cur!.newLines.push({ text: t.slice(1), ctx: cur!.oldLines.length - 1 });
      } else if (t[0] === '-') {
        cur!.oldLines.push(t.slice(1));
      } else {
        cur!.newLines.push({ text: t.slice(1), ctx: null });
      }
      continue;
    }
    throw new Exit2(`error: parse ${r.no}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headLine}`);
  return (tree: Tree): void => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const curText = tree.get(path);
    if (curText === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const doc = splitDoc(curText);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = firstHit(doc.lines, [ch.anchor], cursor, strict, false);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.at + 1;
      }
      if (ch.oldLines.length === 0) {
        const at = ch.eof ? doc.lines.length : cursor;
        const ins = ch.newLines.map((nl) => nl.text);
        doc.lines.splice(at, 0, ...ins);
        cursor = at + ins.length;
      } else {
        const hit = firstHit(doc.lines, ch.oldLines, cursor, strict, ch.eof);
        if (hit === null) throw new Fail('no-match', path);
        const outs = buildNew(ch.newLines, doc.lines, hit.at, hit.tier, ch.oldLines[0]!);
        doc.lines.splice(hit.at, ch.oldLines.length, ...outs);
        cursor = hit.at + outs.length;
      }
    }
    const text = joinDoc(doc);
    if (moveTo !== null) {
      tree.now.set(moveTo, text);
      tree.now.set(path, null);
      moves.push([path, moveTo]);
    } else {
      tree.now.set(path, text);
    }
  };
}

/** Split the patch into sections between Begin Patch and End Patch. */
function parseV4a(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const l = lines[i]!;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      path = l.slice('*** Add File: '.length).trim();
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = l.slice('*** Delete File: '.length).trim();
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'update';
      path = l.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headLine = i + 1;
    i += 1;
    const raw: RawLine[] = [];
    while (i < last) {
      const m = lines[i]!;
      if (m.startsWith('*** Add File: ') || m.startsWith('*** Delete File: ') || m.startsWith('*** Update File: ') || m.trim() === '*** End Patch') break;
      raw.push({ text: m, no: i + 1 });
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text === '') fileLines.push('');
        else if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.no}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
    } else if (kind === 'delete') {
      for (const r of raw) {
        if (!blank(r.text)) throw new Exit2(`error: parse ${r.no}`);
      }
      edits.push(v4aDeleteEdit(path));
    } else {
      edits.push(v4aUpdateEdit(path, raw, headLine, strict, moves));
    }
  }
  return edits;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Order and atomicity (SPEC.md section 10), output and exit codes (section 2)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: Array<[string, string]> = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(parseUnified(lines), strict, moves);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const changes: Array<{ p: string; was: string | null; now: string | null }> = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changes.push({ p, was, now });
  }
  // A move that succeeded prints as one R line, sorted by its new path, when the old path
  // existed before and does not after, and the new path did not exist before and does after.
  const rByNew = new Map<string, string>();
  for (const [oldP, newP] of moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      if (!rByNew.has(newP)) rByNew.set(newP, oldP);
    }
  }
  const rOlds = new Set<string>([...rByNew.values()]);
  const rows: Array<{ key: string; text: string }> = [];
  for (const c of changes) {
    if (rOlds.has(c.p)) continue;
    if (rByNew.has(c.p)) {
      rows.push({ key: c.p, text: `R ${rByNew.get(c.p)} -> ${c.p}` });
      continue;
    }
    rows.push({ key: c.p, text: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${c.p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const c of changes) {
      if (c.now === null) rmSync(c.p, { force: true });
    }
    for (const c of changes) {
      if (c.now === null) continue;
      try {
        if (statSync(c.p).isDirectory() && readdirSync(c.p).length === 0) rmSync(c.p, { force: true });
      } catch {
        // not there, or not a directory: the write below creates what is needed
      }
      mkdirSync(dirname(c.p), { recursive: true });
      writeFileSync(c.p, c.now);
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
