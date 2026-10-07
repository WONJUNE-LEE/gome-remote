import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";

// Compiles one src/*.ts module and runs it in a fresh context with only the globals the
// test supplies, so a test sees exactly what the browser or app would give the module.
// `modules` maps an import specifier to what `require` returns for it, so a module
// that imports others (main.ts) can be given fakes or other loaded modules.
export async function loadTs(name, globals = {}, modules = {}) {
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
  const require = (specifier) => {
    if (!(specifier in modules))
      throw new Error(
        `${name} imports ${specifier}, which the test did not supply`,
      );
    return modules[specifier];
  };
  vm.runInNewContext(outputText, { exports, require, window: {}, ...globals });
  return exports;
}
