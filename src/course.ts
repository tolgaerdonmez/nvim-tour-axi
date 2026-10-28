// Course file tools: `add` merges a chapter into a course, `check` verifies every step against the
// project. Ported from the draft's course.lua; the course JSON format is unchanged.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { AxiError } from "axi-sdk-js";

export interface Mark {
  line?: number;
  text?: string;
}

export interface Step {
  id?: string;
  title?: string;
  section?: string;
  file?: string;
  range?: number[];
  anchor?: string;
  marks?: Mark[];
  body?: string | string[];
  [key: string]: unknown;
}

export interface Course {
  title?: string;
  steps: Step[];
  [key: string]: unknown;
}

export interface Problem {
  step: number;
  id: string;
  problem: string;
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
}

function decode(path: string): unknown {
  const text = readText(path);
  if (text === undefined) {
    throw new AxiError(`cannot read ${path}`, "NOT_FOUND");
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AxiError(`${path}: ${message}`, "INVALID_JSON");
  }
}

function decodeCourse(path: string): Course {
  const value = decode(path);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AxiError(`${path}: a course is a JSON object with \`steps\``, "INVALID_COURSE");
  }
  const course = value as Course;
  if (course.steps === undefined) {
    course.steps = [];
  }
  if (!Array.isArray(course.steps)) {
    throw new AxiError(`${path}: \`steps\` must be an array`, "INVALID_COURSE");
  }
  return course;
}

export interface AddResult {
  added: number;
  skipped: number;
  total: number;
}

// Appends CHAPTER's steps (a JSON array, or an object with `steps`) whose ids are new, or inserts
// them after the step `after` (a deeper dive the learner asked for). Creates COURSE if missing and
// writes atomically, so a watching Neovim never reads half a file.
export function addChapter(coursePath: string, chapterPath: string, after?: string): AddResult {
  const course: Course =
    readText(coursePath) !== undefined ? decodeCourse(coursePath) : { title: "", steps: [] };
  const chapter = decode(chapterPath) as { title?: unknown; steps?: unknown } | unknown[];
  const steps = Array.isArray(chapter) ? chapter : (chapter as { steps?: unknown })?.steps;
  if (!Array.isArray(steps)) {
    throw new AxiError("the chapter has no steps", "INVALID_CHAPTER", [
      "A chapter is a JSON array of steps, or an object with `steps`",
    ]);
  }
  for (const s of steps as Step[]) {
    if (typeof s !== "object" || s === null || !s.id || !s.title) {
      throw new AxiError("every step needs `id` and `title`", "INVALID_CHAPTER");
    }
  }
  if (!Array.isArray(chapter) && typeof chapter.title === "string" && (course.title ?? "") === "") {
    course.title = chapter.title;
  }

  const known = new Set(course.steps.map((s) => s.id ?? ""));
  let at = course.steps.length;
  if (after !== undefined) {
    const i = course.steps.findLastIndex((s) => s.id === after);
    if (i < 0) {
      throw new AxiError(`no step \`${after}\` to insert after`, "NOT_FOUND", [
        `Run \`nvim-tour-axi check ${coursePath}\` to list the course's step ids`,
      ]);
    }
    at = i + 1;
  }
  let added = 0;
  for (const s of steps as Step[]) {
    if (known.has(s.id!)) {
      continue;
    }
    course.steps.splice(at, 0, s);
    at += 1;
    known.add(s.id!);
    added += 1;
  }

  const tmp = `${coursePath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(course, null, 2)}\n`, "utf-8");
  renameSync(tmp, coursePath);
  return { added, skipped: steps.length - added, total: course.steps.length };
}

// Neovim's line count: a trailing newline ends the last line rather than starting a new one.
function fileLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

// Verifies each step: its file exists, range and marks lie inside it, and the anchor is on the
// range's first line.
export function checkCourse(coursePath: string, root: string): { steps: number; problems: Problem[] } {
  const course = decodeCourse(coursePath);
  const problems: Problem[] = [];
  course.steps.forEach((s, i) => {
    const bad = (problem: string) => problems.push({ step: i + 1, id: s.id ?? "?", problem });
    if (!s.file) {
      return;
    }
    const path = isAbsolute(s.file) ? s.file : join(root, s.file);
    const text = readText(path);
    if (text === undefined) {
      bad(`no file ${s.file}`);
      return;
    }
    const lines = fileLines(text);
    const n = lines.length;
    const r = s.range ?? [];
    const [first, last] = r;
    if (
      (first !== undefined && (!Number.isInteger(first) || first < 1 || first > n)) ||
      (last !== undefined && (!Number.isInteger(last) || last < (first ?? 1) || last > n))
    ) {
      bad(`range ${first}-${last} outside 1-${n}`);
    }
    for (const m of s.marks ?? []) {
      if (m.line === undefined || !Number.isInteger(m.line) || m.line < 1 || m.line > n) {
        bad(`mark line ${m.line} outside the file`);
      }
    }
    if (
      s.anchor &&
      Number.isInteger(first) &&
      first >= 1 &&
      first <= n &&
      !lines[first - 1].includes(s.anchor)
    ) {
      bad(`anchor ${JSON.stringify(s.anchor)} not on line ${first}`);
    }
  });
  return { steps: course.steps.length, problems };
}
