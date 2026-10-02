import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";

async function browser() {
  const source = await readFile(
    new URL("../src/api.ts", import.meta.url),
    "utf8",
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  });
  const calls = [];
  let entry;
  const document = {
    fullscreenElement: null,
    documentElement: {
      requestFullscreen() {
        calls.push("enter");
        entry = Promise.withResolvers();
        return entry.promise;
      },
    },
    async exitFullscreen() {
      calls.push("exit");
      document.fullscreenElement = null;
    },
  };
  const exports = {};
  vm.runInNewContext(outputText, { exports, window: {}, document });
  return {
    api: exports.api,
    calls,
    document,
    completeEntry() {
      document.fullscreenElement = document.documentElement;
      entry.resolve();
    },
    rejectEntry() {
      entry.reject(new Error("Fullscreen denied"));
    },
  };
}

test("browser windowed intent waits for pending entry and exits exactly once", async () => {
  const f = await browser();
  const entering = f.api.fullscreen(true);
  assert.deepEqual(f.calls, ["enter"], "request starts in the user gesture");
  const exiting = f.api.fullscreen(false);
  assert.deepEqual(f.calls, ["enter"]);
  f.completeEntry();
  await Promise.all([entering, exiting]);
  assert.deepEqual(f.calls, ["enter", "exit"]);
  assert.equal(f.document.fullscreenElement, null);
  await f.api.fullscreen(false);
  assert.deepEqual(f.calls, ["enter", "exit"], "already windowed is a no-op");
  const retry = f.api.fullscreen(true);
  f.completeEntry();
  await retry;
  assert.equal(await f.api.fullscreenState(), true);
  await f.api.fullscreen(false);
  assert.deepEqual(f.calls, ["enter", "exit", "enter", "exit"]);
});

test("browser fullscreen rejection allows a later attempt", async () => {
  const f = await browser();
  const denied = f.api.fullscreen(true);
  f.rejectEntry();
  await assert.rejects(denied, /Fullscreen denied/);
  const retry = f.api.fullscreen(true);
  f.completeEntry();
  await retry;
  assert.deepEqual(f.calls, ["enter", "enter"]);
  assert.equal(await f.api.fullscreenState(), true);
});
