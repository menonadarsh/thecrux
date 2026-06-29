import assert from "node:assert/strict";
import { test } from "node:test";
import { isMarkdown, renderMarkdown } from "../src/render/markdown.js";

test("isMarkdown recognizes markdown filenames", () => {
  assert.equal(isMarkdown("README.md"), true);
  assert.equal(isMarkdown("docs/guide.markdown"), true);
  assert.equal(isMarkdown("index.html"), false);
  assert.equal(isMarkdown("notes.txt"), false);
});

test("renderMarkdown renders basic markdown", () => {
  const html = renderMarkdown("# Title\n\n**bold** and `code`");
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
});

test("renderMarkdown highlights fenced code blocks", () => {
  const html = renderMarkdown("```js\nconst x = 1;\n```");
  assert.match(html, /hljs/);
  assert.match(html, /hljs-keyword/);
});

test("renderMarkdown strips script tags and inline handlers", () => {
  const html = renderMarkdown("# Hi\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>");
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /onerror/i);
});

test("renderMarkdown blocks javascript: links but keeps safe ones", () => {
  const html = renderMarkdown("[evil](javascript:alert(1)) [ok](https://example.com)");
  assert.doesNotMatch(html, /href="javascript:/i);
  assert.match(html, /href="https:\/\/example\.com"/);
  assert.match(html, /rel="noopener nofollow ugc"/);
  assert.match(html, /target="_blank"/);
});
