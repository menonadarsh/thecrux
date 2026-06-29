import fs from "node:fs";
import path from "node:path";
import { repoDir } from "../git/exec.js";
import { writeJsonAtomic } from "../util/atomic.js";

export type IssueState = "open" | "closed";

/** A comment on an issue or pull request. */
export interface Comment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
}

export interface Issue {
  id: number;
  title: string;
  body: string;
  author: string;
  state: IssueState;
  createdAt: string;
  closedAt?: string;
  closedBy?: string;
  labels?: string[];
  assignees?: string[];
  comments: Comment[];
}

interface IssueFile {
  nextId: number;
  issues: Issue[];
}

function issuesPath(dir: string): string {
  return path.join(dir, "crux-issues.json");
}

function load(dir: string): IssueFile {
  try {
    return JSON.parse(fs.readFileSync(issuesPath(dir), "utf8"));
  } catch {
    return { nextId: 1, issues: [] };
  }
}

async function save(dir: string, data: IssueFile): Promise<void> {
  await writeJsonAtomic(issuesPath(dir), data);
}

/** Next id for a comment within a thread. */
export function nextCommentId(comments: Comment[]): number {
  return comments.reduce((max, c) => Math.max(max, c.id), 0) + 1;
}

export function listIssues(name: string, state?: IssueState): Issue[] {
  const dir = repoDir(name);
  if (!dir) return [];
  const all = load(dir).issues.slice().sort((a, b) => b.id - a.id);
  return state ? all.filter((i) => i.state === state) : all;
}

export function countOpenIssues(name: string): number {
  return listIssues(name, "open").length;
}

export function getIssue(name: string, id: number): Issue | null {
  const dir = repoDir(name);
  if (!dir) return null;
  return load(dir).issues.find((i) => i.id === id) ?? null;
}

export async function createIssue(
  name: string,
  input: { title: string; body: string; author: string },
): Promise<Issue> {
  const dir = repoDir(name);
  if (!dir) throw new Error("repository not found");
  const data = load(dir);
  const issue: Issue = {
    id: data.nextId,
    title: input.title.trim(),
    body: input.body.trim(),
    author: input.author,
    state: "open",
    createdAt: new Date().toISOString(),
    comments: [],
  };
  data.nextId += 1;
  data.issues.push(issue);
  await save(dir, data);
  return issue;
}

export async function updateIssue(
  name: string,
  id: number,
  patch: Partial<Issue>,
): Promise<Issue | null> {
  const dir = repoDir(name);
  if (!dir) return null;
  const data = load(dir);
  const issue = data.issues.find((i) => i.id === id);
  if (!issue) return null;
  Object.assign(issue, patch);
  await save(dir, data);
  return issue;
}

export async function addIssueComment(
  name: string,
  id: number,
  author: string,
  body: string,
): Promise<Comment | null> {
  const dir = repoDir(name);
  if (!dir) return null;
  const data = load(dir);
  const issue = data.issues.find((i) => i.id === id);
  if (!issue) return null;
  const comment: Comment = {
    id: nextCommentId(issue.comments),
    author,
    body: body.trim(),
    createdAt: new Date().toISOString(),
  };
  issue.comments.push(comment);
  await save(dir, data);
  return comment;
}
