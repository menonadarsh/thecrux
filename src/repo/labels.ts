import fs from "node:fs";
import path from "node:path";
import { repoDir, repoDirFor } from "../git/exec.js";
import { writeJsonAtomic } from "../util/atomic.js";

export interface LabelDef {
  name: string;
  color: string; // #rrggbb
}

export const DEFAULT_LABELS: LabelDef[] = [
  { name: "bug", color: "#d73a4a" },
  { name: "enhancement", color: "#0e8a16" },
  { name: "question", color: "#8250df" },
  { name: "documentation", color: "#0075ca" },
];

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const LABEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,38}$/;

export function isValidColor(color: string): boolean {
  return COLOR_RE.test(color);
}
export function isValidLabelName(name: string): boolean {
  return LABEL_NAME_RE.test(name.trim());
}

/** Resolve the labels file path. Works for repos that already exist on disk. */
function labelsPath(slug: string): string | null {
  const dir = repoDir(slug);
  return dir ? path.join(dir, "crux-labels.json") : null;
}

export function listLabels(slug: string): LabelDef[] {
  const file = labelsPath(slug);
  if (!file) return [];
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(data)
      ? data.filter((d): d is LabelDef => d && typeof d.name === "string" && typeof d.color === "string")
      : [];
  } catch {
    return [];
  }
}

async function save(slug: string, defs: LabelDef[]): Promise<void> {
  const file = labelsPath(slug);
  if (!file) return;
  await writeJsonAtomic(file, defs);
}

/** Seed the default label set for a freshly created repo (owner/name). */
export async function seedDefaultLabels(owner: string, name: string): Promise<void> {
  const file = path.join(repoDirFor(owner, name), "crux-labels.json");
  await writeJsonAtomic(file, DEFAULT_LABELS);
}

export async function addLabel(slug: string, name: string, color: string): Promise<LabelDef[]> {
  const labels = listLabels(slug);
  const trimmed = name.trim();
  if (!labels.some((l) => l.name.toLowerCase() === trimmed.toLowerCase())) {
    labels.push({ name: trimmed, color });
    await save(slug, labels);
  }
  return labels;
}

export async function removeLabel(slug: string, name: string): Promise<LabelDef[]> {
  const labels = listLabels(slug).filter((l) => l.name.toLowerCase() !== name.toLowerCase());
  await save(slug, labels);
  return labels;
}

/** Keep only the given names that are real labels in this repo. */
export function validLabelNames(slug: string, names: string[]): string[] {
  const valid = new Set(listLabels(slug).map((l) => l.name));
  return names.filter((n) => valid.has(n));
}

/** Look up the color for a label name (for rendering), or a neutral default. */
export function labelColor(slug: string, name: string): string {
  return listLabels(slug).find((l) => l.name === name)?.color ?? "#8b949e";
}
