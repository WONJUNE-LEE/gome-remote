import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// src/agent-input.ts places a pointer on the picture as `object-fit: contain` draws it.
// If the stylesheet stopped saying so, every click would land in the wrong place; the page
// cannot show that in a test without a browser, so the rule is read from the source.
const css = (
  await readFile(new URL("../src/style.css", import.meta.url), "utf8")
).replace(/\s+/g, " ");
const rule = (selector) => {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `rule ${selector}`);
  return css.slice(start, css.indexOf("}", start));
};

test("the Mac picture is letterboxed with object-fit: contain and fills the viewer", () => {
  assert.match(rule(".agent-video"), /object-fit: contain/);
  assert.match(rule(".agent-video"), /width: 100%/);
  assert.match(rule(".agent-video"), /height: 100%/);
  assert.match(rule(".agent-surface"), /width: 100%/);
  assert.match(rule(".display.agent-display"), /height: 100%/);
});

test("the viewer's own pointer is the one shown over a Mac picture, as an ordinary arrow", () => {
  assert.match(rule(".agent-video"), /cursor: default/);
  assert.match(rule(".agent-surface"), /cursor: default/);
  assert.doesNotMatch(rule(".agent-video"), /cursor: none/);
});

test("the new tile states are drawn like the other unavailable states", () => {
  assert.match(
    css,
    /\.is-setup \.dot, \.is-permission \.dot, \.is-locked \.dot, \.is-suspect \.dot \{/,
  );
});
