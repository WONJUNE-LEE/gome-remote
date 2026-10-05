import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// There is no DOM in this test suite, so these read the sources for the rules that keep
// the remote picture clean. They fail loudly if a rewrite drops one; the manual
// checklist in the plan covers what only a browser can show.
const read = (name) =>
  readFile(new URL(`../src/${name}`, import.meta.url), "utf8");
const css = (await read("style.css")).replace(/\s+/g, " ");
const main = await read("main.ts");
const tiles = await read("tiles.ts");
const body = (selector) => {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `rule ${selector}`);
  return css.slice(start, css.indexOf("}", start));
};

test("only the remote cursor shows over a connected desktop", () => {
  assert.match(
    css,
    /\.remote-surface\.remote-connected, \.remote-surface\.remote-connected \* \{ cursor: none !important; \}/,
  );
  assert.match(body(".remote-cursor"), /visibility: hidden/);
  assert.match(
    body(".remote-connected.remote-pointer-active .remote-cursor"),
    /visibility: visible/,
  );
  assert.match(
    main,
    /getCursorLayer\(\)\.getElement\(\)\.classList\.add\("remote-cursor"\)/,
  );
});

test("nothing is drawn over remote pixels: the overlay hides on connect and the browser bar is in the page flow", () => {
  assert.match(main, /state === 3\) \{[^}]*el\("overlay"\)\.hidden = true/);
  assert.match(body(".session-toolbar"), /flex-shrink: 0/);
  assert.doesNotMatch(body(".session-toolbar"), /position: (absolute|fixed)/);
  assert.match(body(".session"), /display: flex/);
  assert.match(css, /\.app-mode \.browser-only \{ display: none; \}/);
});

test("F11 stays local and the viewer keeps its commands", () => {
  assert.match(main, /if \(!appMode\) \{[^}]*key !== "F11"/s);
  for (const command of [
    "resolution:",
    '"back"',
    '"disconnect"',
    '"reconnect"',
    '"text-input"',
  ])
    assert.ok(main.includes(command), command);
  assert.match(main, /client\.sendSize\(width, height\)/);
  assert.match(main, /createClipboardStream\("text\/plain"\)/);
});

test("the list uses the approved palette, dark mode and state words", () => {
  for (const colour of [
    "#f6f3ee",
    "#22201e",
    "#2e2b28",
    "#e95420",
    "#a83a1c",
    "#9aa3b2",
    "#5d6573",
  ])
    assert.ok(css.includes(colour), colour);
  assert.match(css, /prefers-color-scheme: dark/);
  for (const word of ["켜짐", "꺼짐", "설정 필요"])
    assert.ok(tiles.includes(word), word);
  for (const text of [
    "연결이 끊겼습니다",
    "작업은 그대로 남아 있습니다",
    "다시 연결",
    "목록으로",
    "서버에 연결할 수 없습니다",
    "다시 시도",
    "이 기기의 Tailscale 계정으로는 쓸 수 없습니다",
  ])
    assert.ok(main.includes(text), text);
});

// Grep-only on purpose: main.ts builds the whole page and talks to Guacamole, and this
// suite has no DOM, so a behavioural test would need a fake of both. The behaviour behind
// each rule is covered by the tile and API tests or by the manual browser check.
test("the server address is app-only, tiles that cannot open are real disabled buttons", () => {
  assert.match(main, /el\("menu-address"\)\.hidden = !appMode/);
  assert.match(main, /el\("state-address"\)\.hidden = !appMode/);
  assert.match(
    main,
    /el\("state-address"\)\.hidden = !appMode \|\| kind !== "unreachable"/,
  );
  assert.match(main, /tile\.disabled = !tileEnabled\(target\)/);
  assert.match(
    main,
    /if \(!targets\.includes\(target\) \|\| !tileEnabled\(target\)\) return/,
  );
});

test("a failed or refused connection is never retried on its own", () => {
  // Retrying a refused Mac login by itself could lock the account; only a click reconnects.
  assert.doesNotMatch(main, /setTimeout|setInterval/);
  const reconnects = main.match(/void connect\(/g) || [];
  assert.equal(
    reconnects.length,
    2,
    "only opening a tile and the reconnect action",
  );
  assert.match(
    main,
    /function reconnect\(\) \{\s*if \(lastInput && !active\) void connect\(lastInput\);/,
  );
});

test("screens keep to the minimal copy of the spec", () => {
  const dialog = main.match(/<dialog id="text-dialog">.*?<\/dialog>/s)[0];
  assert.equal((dialog.match(/<p[ >]/g) || []).length, 1, "one short line");
  assert.ok(
    dialog.match(/<p[^>]*>([^<]*)</)[1].length <= 30,
    "the line stays short",
  );
  for (const banned of ["워크스페이스", "사이드바"]) {
    assert.equal(main.includes(banned), false, banned);
    assert.equal(css.includes(banned), false, banned);
  }
});

test("the ended view offers 다시 연결 once, in the overlay card", () => {
  assert.equal((main.match(/다시 연결/g) || []).length, 1);
  assert.doesNotMatch(main, /id="reconnect"|el\("reconnect"\)/);
  assert.match(main, /el\("overlay-reconnect"\)\.onclick = reconnect/);
});

// WCAG relative luminance contrast of two #rrggbb colours.
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test("a disabled tile keeps its state word readable (AA 4.5:1) in light and dark", () => {
  // The tile is not faded as a whole; only the colour block and the dot are dimmed.
  assert.match(body(".tile:disabled"), /opacity: 1[;\s]/);
  assert.match(body(".tile:disabled .tile-art"), /opacity/);
  assert.match(body(".tile:disabled .dot"), /opacity/);
  const light = css.match(/:root \{[^}]*\}/)[0];
  const dark = css.match(/prefers-color-scheme: dark\) \{ :root \{[^}]*\}/)[0];
  const value = (block, name) =>
    block.match(new RegExp(`${name}: (#[0-9a-f]{6})`, "i"))[1];
  assert.ok(contrast(value(light, "--muted"), value(light, "--tile")) >= 4.5);
  assert.ok(contrast(value(dark, "--muted"), value(dark, "--tile")) >= 4.5);
});
