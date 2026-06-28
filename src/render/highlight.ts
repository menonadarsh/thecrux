import hljs from "highlight.js";

/** Map file extensions / basenames to highlight.js language identifiers. */
const EXT_LANG: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  json: "json",
  md: "markdown",
  markdown: "markdown",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  css: "css",
  scss: "scss",
  less: "less",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  sql: "sql",
  swift: "swift",
  kt: "kotlin",
  lua: "lua",
  pl: "perl",
  r: "r",
  dockerfile: "dockerfile",
  makefile: "makefile",
};

const BASENAME_LANG: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  ".gitignore": "plaintext",
};

const HTML_ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPE[c]);
}

/** Best-effort language id for a file, or null if unknown. */
export function detectLanguage(filename: string): string | null {
  const base = filename.split("/").pop() ?? filename;
  const lower = base.toLowerCase();
  if (BASENAME_LANG[lower]) return BASENAME_LANG[lower];
  const dot = lower.lastIndexOf(".");
  if (dot === -1) return null;
  const ext = lower.slice(dot + 1);
  return EXT_LANG[ext] ?? null;
}

export interface Highlighted {
  /** Safe HTML (entities escaped, hljs token spans), newlines preserved. */
  html: string;
  language: string | null;
}

/** Highlight a code string for a given filename. Falls back to plain escaping. */
export function highlightFile(code: string, filename: string): Highlighted {
  const language = detectLanguage(filename);
  if (language && language !== "plaintext" && hljs.getLanguage(language)) {
    try {
      const { value } = hljs.highlight(code, { language, ignoreIllegals: true });
      return { html: value, language };
    } catch {
      // fall through to plain
    }
  }
  return { html: escapeHtml(code), language: null };
}

/** Highlight a fenced code block by language name (used inside markdown). */
export function highlightLang(code: string, lang: string | undefined): string {
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    } catch {
      // fall through
    }
  }
  return escapeHtml(code);
}
