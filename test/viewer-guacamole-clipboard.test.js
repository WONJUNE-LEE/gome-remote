import test from "node:test";
import assert from "node:assert/strict";
import { viewer } from "./helpers/viewer-harness.js";
import { loadTs } from "./helpers/load-ts.js";

const plain = (value) => JSON.parse(JSON.stringify(value));
const base = {
  persistent: true,
  online: true,
  ready: true,
};
const macVnc = {
  ...base,
  id: "mac-vnc",
  name: "Mac (VNC)",
  platform: "mac",
  protocol: "vnc",
};
const linuxRdp = {
  ...base,
  id: "linux",
  name: "Linux",
  platform: "linux",
  protocol: "rdp",
};
const NOTICES = (
  await loadTs(
    "clipboard-sync.ts",
    {},
    { "./agent-input": await loadTs("agent-input.ts") },
  )
).NOTICE_TEXT;

const META = 0xffe7;
const CTRL = 0xffe3;
const SHIFT = 0xffe1;
const INSERT = 0xff63;
const V = 0x76;

// A connected session on the first target; the page is in the app (bridge 4) by default.
async function session(target, options = {}) {
  const v = await viewer({ appMode: true, targets: [target], ...options });
  v.tiles()[0].click();
  await v.settle();
  const client = v.clients.at(-1);
  client.onstatechange(3);
  await v.settle();
  const keyboard = v.keyboards.at(-1);
  return {
    v,
    client,
    keyboard,
    surface: keyboard.element,
    mouse: v.mice.at(-1),
  };
}
// A key event as the page's surface receives it: the DOM fields the paste decision reads
// and the keysym the (fake) Guacamole keyboard would translate it to.
const down = (surface, keysym, code, key, mods = {}) =>
  surface.dispatchEvent({
    type: "keydown",
    keysym,
    code,
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault() {},
    ...mods,
  });
const up = (surface, keysym) =>
  surface.dispatchEvent({ type: "keyup", keysym });
const clipboards = (client) =>
  client.log.filter((e) => e[0] === "clipboard").map((e) => e[2]);
const keys = (client) =>
  client.log
    .filter((e) => e[0] === "key")
    .map((e) => `${e[1] ? "down" : "up"}:${e[2].toString(16)}`);

const pastes = {
  "Meta+V on a Mac VNC target": {
    target: macVnc,
    press(s) {
      down(s, META, "MetaLeft", "Meta", { metaKey: true });
      down(s, V, "KeyV", "v", { metaKey: true });
      up(s, V);
      up(s, META);
    },
    expected: [
      `down:${META.toString(16)}`,
      "CLIPBOARD",
      "down:76",
      "up:76",
      `up:${META.toString(16)}`,
    ],
  },
  "Ctrl+V on an RDP target": {
    target: linuxRdp,
    press(s) {
      down(s, CTRL, "ControlLeft", "Control", { ctrlKey: true });
      down(s, V, "KeyV", "v", { ctrlKey: true });
      up(s, V);
      up(s, CTRL);
    },
    expected: [
      `down:${CTRL.toString(16)}`,
      "CLIPBOARD",
      "down:76",
      "up:76",
      `up:${CTRL.toString(16)}`,
    ],
  },
  "Ctrl+Shift+V on an RDP target": {
    target: linuxRdp,
    press(s) {
      down(s, CTRL, "ControlLeft", "Control", { ctrlKey: true });
      down(s, SHIFT, "ShiftLeft", "Shift", { ctrlKey: true, shiftKey: true });
      down(s, V, "KeyV", "V", { ctrlKey: true, shiftKey: true });
      up(s, V);
      up(s, SHIFT);
      up(s, CTRL);
    },
    expected: [
      `down:${CTRL.toString(16)}`,
      `down:${SHIFT.toString(16)}`,
      "CLIPBOARD",
      "down:76",
      "up:76",
      `up:${SHIFT.toString(16)}`,
      `up:${CTRL.toString(16)}`,
    ],
  },
  "Shift+Insert on an RDP target": {
    target: linuxRdp,
    press(s) {
      down(s, SHIFT, "ShiftLeft", "Shift", { shiftKey: true });
      down(s, INSERT, "Insert", "Insert", { shiftKey: true });
      up(s, INSERT);
      up(s, SHIFT);
    },
    expected: [
      `down:${SHIFT.toString(16)}`,
      "CLIPBOARD",
      `down:${INSERT.toString(16)}`,
      `up:${INSERT.toString(16)}`,
      `up:${SHIFT.toString(16)}`,
    ],
  },
};

for (const [name, { target, press, expected }] of Object.entries(pastes))
  test(`a_guacamole_session_sends_changed_client_text_before_the_paste_key: ${name}`, async () => {
    const { v, client, surface } = await session(target, {
      clipboardText: "붙일 글",
    });
    assert.equal(v.clipboard.reads, 0, "the session start reads nothing");
    assert.deepEqual(clipboards(client), [], "and pushes nothing");
    press(surface);
    await v.settle();
    const order = client.log.map((e) =>
      e[0] === "clipboard"
        ? "CLIPBOARD"
        : `${e[1] ? "down" : "up"}:${e[2].toString(16)}`,
    );
    assert.deepEqual(order, expected);
    assert.deepEqual(clipboards(client), ["붙일 글"]);
    // The same text again is not sent twice.
    press(surface);
    await v.settle();
    assert.deepEqual(clipboards(client), ["붙일 글"]);
  });

test("the stream carries the text as text/plain", async () => {
  const { v, client, surface } = await session(linuxRdp, {
    clipboardText: "a\nb",
  });
  pastes["Ctrl+V on an RDP target"].press(surface);
  await v.settle();
  assert.deepEqual(
    client.log.find((e) => e[0] === "clipboard"),
    ["clipboard", "text/plain", "a\nb"],
  );
});

test("remote_clipboard_updates_the_client_only_while_focused_and_is_not_echoed", async () => {
  const { v, client, surface } = await session(macVnc);
  const remote = (text) => {
    client.onclipboard({ id: 1 }, "text/plain");
    const reader = v.readers.at(-1);
    // The text arrives in pieces and is complete at the end of the stream.
    reader.ontext(text.slice(0, 1));
    reader.ontext(text.slice(1));
    reader.onend();
  };
  const before = v.readers.length;
  client.onclipboard({ id: 9 }, "image/png");
  assert.equal(v.readers.length, before, "other mimetypes are not read");
  remote("원격 글");
  await v.settle();
  assert.deepEqual(plain(v.clipboard.writes), [
    ["원격 글", { concealed: false }],
  ]);
  // Not echoed: the local clipboard now holds it, so the same text on the next paste is
  // not sent back to the remote.
  v.clipboard.text = "원격 글";
  pastes["Meta+V on a Mac VNC target"].press(surface);
  await v.settle();
  assert.deepEqual(clipboards(client), []);
  // Blurred: dropped, not queued.
  v.setWindowFocus(false);
  await v.settle();
  remote("흐린 글");
  await v.settle();
  assert.equal(v.clipboard.writes.length, 1);
  v.setWindowFocus(true);
  await v.settle();
  assert.equal(
    v.clipboard.writes.length,
    1,
    "and not written on the next focus",
  );
});

test("a remote text over 64 KiB is not written and the user is told", async () => {
  const { v, client } = await session(linuxRdp);
  client.onclipboard({ id: 1 }, "text/plain");
  const reader = v.readers.at(-1);
  reader.ontext("가".repeat(21_846));
  reader.onend();
  await v.settle();
  assert.deepEqual(v.clipboard.writes, []);
  assert.equal(v.el("notice").textContent, NOTICES["too-large"]);
  client.onclipboard({ id: 2 }, "text/plain");
  const fits = v.readers.at(-1);
  fits.ontext("가".repeat(21_845));
  fits.onend();
  await v.settle();
  assert.equal(v.clipboard.writes.length, 1);
});

test("the_text_dialog_invalidates_the_baseline", async () => {
  const { v, client, surface } = await session(linuxRdp, {
    clipboardText: "A",
  });
  const paste = pastes["Ctrl+V on an RDP target"].press;
  paste(surface);
  await v.settle();
  assert.deepEqual(clipboards(client), ["A"]);
  v.action("text-input");
  v.el("remote-text").value = "B";
  v.el("text-form").onsubmit({ preventDefault() {} });
  assert.deepEqual(
    clipboards(client),
    ["A", "B"],
    "the dialog uses the stream",
  );
  assert.deepEqual(keys(client).slice(-4), [
    `down:${CTRL.toString(16)}`,
    "down:76",
    "up:76",
    `up:${CTRL.toString(16)}`,
  ]);
  assert.equal(v.el("remote-text").value, "");
  // The local clipboard is still "A", but the remote now holds "B".
  paste(surface);
  await v.settle();
  assert.deepEqual(clipboards(client), ["A", "B", "A"]);
});

test("the text dialog uses Command on a Mac target", async () => {
  const { v, client } = await session(macVnc);
  v.action("text-input");
  v.el("remote-text").value = "글";
  v.el("text-form").onsubmit({ preventDefault() {} });
  assert.deepEqual(keys(client), [
    `down:${META.toString(16)}`,
    "down:76",
    "up:76",
    `up:${META.toString(16)}`,
  ]);
});

test("mouse_and_key_events_queue_behind_the_barrier_in_order", async () => {
  const { v, client, surface, mouse } = await session(linuxRdp, {
    clipboardText: "글",
  });
  v.clipboard.hold = true;
  down(surface, CTRL, "ControlLeft", "Control", { ctrlKey: true });
  down(surface, V, "KeyV", "v", { ctrlKey: true });
  await v.settle();
  mouse.onmousemove({ x: 5, y: 6, left: false });
  mouse.onmousedown({ x: 5, y: 6, left: true });
  down(surface, 0x61, "KeyA", "a", { ctrlKey: true });
  mouse.onmouseup({ x: 5, y: 6, left: false });
  assert.deepEqual(
    client.log.map((e) => e[0]),
    ["key"],
    "only the Control key-down is out; the V and everything after wait",
  );
  v.clipboard.hold = false;
  v.clipboard.resolve();
  await v.settle();
  assert.deepEqual(
    client.log.map((e) =>
      e[0] === "mouse"
        ? `mouse:${e[1].left}`
        : e[0] === "key"
          ? `key:${e[2].toString(16)}`
          : e[0],
    ),
    [
      `key:${CTRL.toString(16)}`,
      "clipboard",
      "key:76",
      "mouse:false",
      "mouse:true",
      "key:61",
      "mouse:false",
    ],
  );
});

test("a paste read slower than 500 ms releases the held input and tells the user", async () => {
  const { v, client, surface } = await session(linuxRdp, {
    clipboardText: "글",
  });
  v.clipboard.hold = true;
  pastes["Ctrl+V on an RDP target"].press(surface);
  await v.settle();
  assert.deepEqual(keys(client), [`down:${CTRL.toString(16)}`]);
  v.advance(500);
  assert.deepEqual(keys(client), [
    `down:${CTRL.toString(16)}`,
    "down:76",
    "up:76",
    `up:${CTRL.toString(16)}`,
  ]);
  assert.equal(v.el("notice").textContent, NOTICES["read-timeout"]);
  v.clipboard.hold = false;
  v.clipboard.resolve();
  await v.settle();
  assert.deepEqual(clipboards(client), [], "the late text is never sent");
});

test("a mouse state that arrives after the connection ended is not sent", async () => {
  const { v, client, mouse } = await session(linuxRdp);
  client.onerror();
  await v.settle();
  mouse.onmousemove({ x: 1, y: 1 });
  assert.deepEqual(client.log, []);
});

test("window blur and ending the session leave no held key behind or after", async () => {
  const { v, client, surface } = await session(linuxRdp, {
    clipboardText: "글",
  });
  v.clipboard.hold = true;
  pastes["Ctrl+V on an RDP target"].press(surface);
  await v.settle();
  v.setWindowFocus(false);
  await v.settle();
  // Blur: the keys held for the paste go out in order, ending with every key up.
  assert.deepEqual(keys(client).slice(-2), [
    "up:76",
    `up:${CTRL.toString(16)}`,
  ]);
  const out = client.log.length;
  v.clipboard.hold = false;
  v.clipboard.resolve();
  v.advance(1000);
  await v.settle();
  assert.equal(client.log.length, out, "nothing goes out later");
  assert.deepEqual(clipboards(client), []);
});

test("disconnecting with a paste held lets the held keys go before the connection closes, and nothing after", async () => {
  const { v, client, surface } = await session(linuxRdp, {
    clipboardText: "글",
  });
  v.clipboard.hold = true;
  down(surface, CTRL, "ControlLeft", "Control", { ctrlKey: true });
  down(surface, V, "KeyV", "v", { ctrlKey: true });
  await v.settle();
  v.el("disconnect").click();
  assert.equal(client.disconnected, 1);
  assert.deepEqual(
    keys(client).slice(-2).sort(),
    ["up:76", `up:${CTRL.toString(16)}`].sort(),
    "every key that went down is let go",
  );
  const out = client.log.length;
  v.clipboard.hold = false;
  v.clipboard.resolve();
  v.advance(1000);
  await v.settle();
  assert.equal(client.log.length, out);
  assert.deepEqual(clipboards(client), []);
});

test("a new session starts with a fresh baseline and pushes nothing", async () => {
  const { v, client, surface } = await session(linuxRdp, {
    clipboardText: "같은 글",
  });
  pastes["Ctrl+V on an RDP target"].press(surface);
  await v.settle();
  assert.deepEqual(clipboards(client), ["같은 글"]);
  client.onerror();
  await v.settle();
  v.el("overlay-reconnect").click();
  await v.settle();
  const second = v.clients.at(-1);
  assert.notEqual(second, client);
  second.onstatechange(3);
  await v.settle();
  assert.deepEqual(clipboards(second), []);
  pastes["Ctrl+V on an RDP target"].press(v.keyboards.at(-1).element);
  await v.settle();
  assert.deepEqual(clipboards(second), ["같은 글"]);
});

// Review Focus 4: no local clipboard (an old app, or a browser without the permission API)
// means no sync, and the keys behave as they did before.
for (const [name, options] of Object.entries({
  "an old app (bridge 3)": { appMode: true, bridgeVersion: 3 },
  "a browser without navigator.clipboard": { appMode: false },
}))
  test(`an_old_app_or_browser_without_permission_still_types_and_pastes_as_before: ${name}`, async () => {
    const { v, client, surface, mouse } = await session(linuxRdp, {
      ...options,
      clipboardText: "글",
    });
    pastes["Ctrl+V on an RDP target"].press(surface);
    mouse.onmousedown({ x: 1, y: 1, left: true });
    assert.deepEqual(
      client.log.map((e) => e[0]),
      ["key", "key", "key", "key", "mouse"],
      "everything goes out at once",
    );
    assert.equal(v.clipboard.reads, 0);
    assert.equal(
      client.onclipboard,
      null,
      "the remote clipboard is not handled",
    );
    assert.deepEqual(clipboards(client), []);
    assert.equal(v.el("notice").hidden, true);
    // The text dialog still works.
    v.action("text-input");
    v.el("remote-text").value = "B";
    v.el("text-form").onsubmit({ preventDefault() {} });
    assert.deepEqual(clipboards(client), ["B"]);
  });

test("a mouse press and release made on one reused state object while a paste is pending both reach the remote", async () => {
  const { v, client, surface, mouse } = await session(linuxRdp, {
    clipboardText: "글",
  });
  v.clipboard.hold = true;
  down(surface, CTRL, "ControlLeft", "Control", { ctrlKey: true });
  down(surface, V, "KeyV", "v", { ctrlKey: true });
  await v.settle();
  // Guacamole.Mouse hands out one state object and mutates it (a wheel step is a press and
  // a release in a row).
  const state = { x: 3, y: 4, left: false, up: false, down: false };
  state.down = true;
  mouse.onmousedown(state);
  state.down = false;
  mouse.onmouseup(state);
  v.clipboard.hold = false;
  v.clipboard.resolve();
  await v.settle();
  assert.deepEqual(
    client.log.filter((e) => e[0] === "mouse").map((e) => e[1].down),
    [true, false],
    "the press was not lost",
  );
});

test("the paste action on a Mac VNC session sends the clipboard stream, then Meta+V", async () => {
  const { v, client } = await session(macVnc, { clipboardText: "메뉴 글" });
  assert.equal(v.el("paste-remote").disabled, false, "enabled once connected");
  v.action("paste-clipboard");
  await v.settle();
  const order = client.log.map((e) =>
    e[0] === "clipboard"
      ? "CLIPBOARD"
      : `${e[1] ? "down" : "up"}:${e[2].toString(16)}`,
  );
  assert.deepEqual(order, [
    "CLIPBOARD",
    `down:${META.toString(16)}`,
    "down:76",
    "up:76",
    `up:${META.toString(16)}`,
  ]);
  assert.deepEqual(clipboards(client), ["메뉴 글"]);
});

test("the #paste-remote button on an RDP session sends Ctrl+V, is disabled before the connection and after the end, and does nothing without a local clipboard", async () => {
  const v = await viewer({
    appMode: true,
    targets: [linuxRdp],
    clipboardText: "글",
  });
  v.tiles()[0].click();
  await v.settle();
  const client = v.clients.at(-1);
  assert.equal(v.el("paste-remote").disabled, true, "before the connection");
  client.onstatechange(3);
  await v.settle();
  assert.equal(v.el("paste-remote").disabled, false);
  const surface = v.keyboards.at(-1).element;
  const focusedBefore = surface.focusCount ?? 0;
  v.el("paste-remote").click();
  await v.settle();
  assert.equal(
    surface.focusCount,
    focusedBefore + 1,
    "typing goes back to the remote screen after the button",
  );
  assert.deepEqual(keys(client), [
    `down:${CTRL.toString(16)}`,
    "down:76",
    "up:76",
    `up:${CTRL.toString(16)}`,
  ]);
  assert.deepEqual(clipboards(client), ["글"]);
  client.onstatechange(5);
  await v.settle();
  assert.equal(v.el("paste-remote").disabled, true, "after the end");

  const old = await session(linuxRdp, { bridgeVersion: 3 });
  assert.equal(old.v.el("paste-remote").disabled, true);
  old.v.action("paste-clipboard");
  old.v.el("paste-remote").click();
  await old.v.settle();
  assert.deepEqual(
    old.client.log.filter((e) => e[0] === "key"),
    [],
  );
});
