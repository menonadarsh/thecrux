import assert from "node:assert/strict";
import { test } from "node:test";
import { detectLanguage, escapeHtml, highlightFile } from "../src/render/highlight.js";

test("detectLanguage maps extensions and basenames", () => {
  assert.equal(detectLanguage("foo.ts"), "typescript");
  assert.equal(detectLanguage("a/b/c.js"), "javascript");
  assert.equal(detectLanguage("style.css"), "css");
  assert.equal(detectLanguage("Makefile"), "makefile");
  assert.equal(detectLanguage("Dockerfile"), "dockerfile");
  assert.equal(detectLanguage("noextension"), null);
  assert.equal(detectLanguage("archive.zip"), null);
});

test("escapeHtml escapes the dangerous characters", () => {
  assert.equal(escapeHtml(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
});

test("highlightFile highlights known languages and escapes plain", () => {
  const js = highlightFile("const x = 1;", "a.js");
  assert.equal(js.language, "javascript");
  assert.match(js.html, /hljs-keyword/);

  const plain = highlightFile("<not> & code", "notes.unknownext");
  assert.equal(plain.language, null);
  assert.match(plain.html, /&lt;not&gt;/);
  assert.doesNotMatch(plain.html, /<not>/);
});
