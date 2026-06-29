import fs from "node:fs";
import path from "node:path";
import { repoDir } from "../git/exec.js";
import { writeJsonAtomic } from "../util/atomic.js";
import { type Comment, nextCommentId } from "../issues/store.js";

export type PullState = "open" | "merged" | "closed";

export interface PullRequest {
  id: number;
  title: string;
  body: string;
  author: string;
  base: string;
  head: string;
  state: PullState;
  createdAt: string;
  mergedAt?: string;
  mergedBy?: string;
  mergeCommit?: string;
  fastForward?: boolean;
  /** Base/head commit SHAs captured at merge time, to snapshot the merged diff. */
  baseSha?: string;
  headSha?: string;
  closedAt?: string;
  labels?: string[];
  assignees?: string[];
  comments?: Comment[];
}

interface PullFile {
  nextId: number;
  pulls: PullRequest[];
}

function pullsPath(dir: string): string {
  return path.join(dir, "crux-pulls.json");
}

function load(dir: string): PullFile {
  try {
    return JSON.parse(fs.readFileSync(pullsPath(dir), "utf8"));
  } catch {
    return { nextId: 1, pulls: [] };
  }
}

async function save(dir: string, data: PullFile): Promise<void> {
  await writeJsonAtomic(pullsPath(dir), data);
}

/** All pull requests for a repo, newest first, optionally filtered by state. */
export function listPulls(name: string, state?: PullState): PullRequest[] {
  const dir = repoDir(name);
  if (!dir) return [];
  const all = load(dir).pulls.slice().sort((a, b) => b.id - a.id);
  return state ? all.filter((p) => p.state === state) : all;
}

export function countOpenPulls(name: string): number {
  return listPulls(name, "open").length;
}

export function getPull(name: string, id: number): PullRequest | null {
  const dir = repoDir(name);
  if (!dir) return null;
  return load(dir).pulls.find((p) => p.id === id) ?? null;
}

export async function createPull(
  name: string,
  input: { title: string; body: string; author: string; base: string; head: string },
): Promise<PullRequest> {
  const dir = repoDir(name);
  if (!dir) throw new Error("repository not found");
  const data = load(dir);
  const pr: PullRequest = {
    id: data.nextId,
    title: input.title.trim() || `${input.head} into ${input.base}`,
    body: input.body.trim(),
    author: input.author,
    base: input.base,
    head: input.head,
    state: "open",
    createdAt: new Date().toISOString(),
  };
  data.nextId += 1;
  data.pulls.push(pr);
  await save(dir, data);
  return pr;
}

export async function addPullComment(
  name: string,
  id: number,
  author: string,
  body: string,
): Promise<Comment | null> {
  const dir = repoDir(name);
  if (!dir) return null;
  const data = load(dir);
  const pr = data.pulls.find((p) => p.id === id);
  if (!pr) return null;
  if (!pr.comments) pr.comments = [];
  const comment: Comment = {
    id: nextCommentId(pr.comments),
    author,
    body: body.trim(),
    createdAt: new Date().toISOString(),
  };
  pr.comments.push(comment);
  await save(dir, data);
  return comment;
}

/** Apply a partial update to a pull request and persist it. */
export async function updatePull(
  name: string,
  id: number,
  patch: Partial<PullRequest>,
): Promise<PullRequest | null> {
  const dir = repoDir(name);
  if (!dir) return null;
  const data = load(dir);
  const pr = data.pulls.find((p) => p.id === id);
  if (!pr) return null;
  Object.assign(pr, patch);
  await save(dir, data);
  return pr;
}
