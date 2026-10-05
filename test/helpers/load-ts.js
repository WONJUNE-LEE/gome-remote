import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";

// Compiles one src/*.ts module and runs it in a fresh context with only the globals the
// test supplies, so a test sees exactly what the browser or app would give the module.
export async function loadTs(name, globals = {}) {
  const source = await readFile(
    new URL(`../../src/${name}`, import.meta.url),
    "utf8",
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  });
  const exports = {};
  vm.runInNewContext(outputText, { exports, window: {}, ...globals });
  return exports;
}
