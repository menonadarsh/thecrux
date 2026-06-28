import { Marked } from "marked";
import { markedHighlight } from "marked-highlight";
import sanitizeHtml from "sanitize-html";
import { highlightLang } from "./highlight.js";

// A configured Marked instance: GitHub-ish line breaks + fenced-code
// highlighting via highlight.js. Output is sanitized before it reaches a page.
const marked = new Marked(
  markedHighlight({
    langPrefix: "hljs language-",
    highlight(code, lang) {
      return highlightLang(code, lang);
    },
  }),
  {
    gfm: true,
    breaks: false,
  },
);

const SANITIZE_OPTS: sanitizeHtml.IOptions = {
  allowedTags: [
    "h1", "h2", "h3", "h4", "h5", "h6",
    "p", "blockquote", "pre", "code", "span",
    "ul", "ol", "li",
    "a", "img",
    "strong", "em", "del", "ins", "sub", "sup",
    "table", "thead", "tbody", "tr", "th", "td",
    "hr", "br",
    "details", "summary",
  ],
  allowedAttributes: {
    a: ["href", "name", "title", "rel", "target"],
    img: ["src", "alt", "title"],
    code: ["class"],
    span: ["class"],
    pre: ["class"],
    th: ["align"],
    td: ["align"],
  },
  // Only safe URL schemes; no javascript:/data: (except images may use https).
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: { img: ["http", "https"] },
  transformTags: {
    // Make external links safe and open in a new tab.
    a: (tagName, attribs) => ({
      tagName,
      attribs: { ...attribs, rel: "noopener nofollow ugc", target: "_blank" },
    }),
  },
};

/** Render untrusted markdown to safe HTML. */
export function renderMarkdown(text: string): string {
  const raw = marked.parse(text, { async: false }) as string;
  return sanitizeHtml(raw, SANITIZE_OPTS);
}

/** Whether a filename should be treated as markdown. */
export function isMarkdown(filename: string): boolean {
  return /\.(md|markdown)$/i.test(filename);
}
