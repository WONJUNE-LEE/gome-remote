import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "../server/config.js";
import {
  CredentialStore,
  readCredentialFile,
  writeCredentialFile,
} from "../server/credentials.js";
import { createManager } from "../server/manage.js";

const TOKEN_ONE = "a".repeat(43);
const TOKEN_TWO = "b".repeat(43);
const TOKEN_NEW = "c".repeat(43);
const LOGIN = "owner@example.com";

const macOne = {
  id: "mac-one",
  name: "Mac One",
  protocol: "agent",
  platform: "mac",
  hostname: "100.64.0.10",
};
const macTwo = {
  id: "mac-two",
  name: "Mac Two",
  protocol: "agent",
  platform: "mac",
  hostname: "100.64.0.20",
};

// Deterministic IDs: t-00000001, t-00000002, ...
function counter() {
  let n = 0;
  return () => {
    n += 1;
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(n);
    return bytes;
  };
}

async function setup(t, { targets = [macOne], credentialDir } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "gr-manage-"));
  t.after(async () => {
    await chmod(join(dir, "creds"), 0o700).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  const credDir = credentialDir ? join(dir, credentialDir) : dir;
  await mkdir(credDir, { recursive: true, mode: 0o700 });
  const credentialsFile = join(credDir, "credentials.json");
  const configPath = join(dir, "gateway.json");
  const raw = {
    socketPath: "/tmp/gome-remote/gateway.sock",
    publicOrigin: "https://gateway.example.ts.net:8450",
    allowedLogins: [LOGIN],
    credentialsFile,
    targets,
  };
  const original = `${JSON.stringify(raw, null, 2)}\n`;
  await writeFile(configPath, original);
  await chmod(configPath, 0o640);
  await writeCredentialFile(
    credentialsFile,
    new Map(
      targets.map((target, i) => [
        target.id,
        { agentToken: i === 0 ? TOKEN_ONE : TOKEN_TWO },
      ]),
    ),
  );
  const config = validateConfig(JSON.parse(original));
  const credentials = new CredentialStore(credentialsFile, {
    targets: config.targets,
  });
  const logs = [];
  const manager = createManager({
    configPath,
    config,
    credentials,
    log: (line) => logs.push(line),
    random: counter(),
  });
  return {
    dir,
    configPath,
    credentialsFile,
    original,
    config,
    credentials,
    logs,
    manager,
  };
}

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

test("add of a Mac with its key writes the target, a backup and the key", async (t) => {
  const s = await setup(t);
  const target = await s.manager.add(LOGIN, {
    name: "Mac Three",
    kind: "mac-agent",
    hostname: "100.64.0.20",
    credential: { agentToken: TOKEN_NEW },
  });
  assert.equal(target.id, "t-00000001");
  const file = await readJson(s.configPath);
  assert.deepEqual(file.targets, [
    macOne,
    {
      id: "t-00000001",
      name: "Mac Three",
      platform: "mac",
      protocol: "agent",
      hostname: "100.64.0.20",
    },
  ]);
  // The file keeps its own content: no defaults filled in.
  assert.equal(Object.hasOwn(file, "guacdPort"), false);
  assert.equal((await stat(s.configPath)).mode & 0o777, 0o640);
  assert.equal(await readFile(`${s.configPath}.prev`, "utf8"), s.original);
  assert.equal((await stat(`${s.configPath}.prev`)).mode & 0o777, 0o640);
  assert.equal((await stat(s.credentialsFile)).mode & 0o777, 0o600);
  const entries = await readCredentialFile(s.credentialsFile);
  assert.deepEqual(entries.get("t-00000001"), { agentToken: TOKEN_NEW });
  assert.deepEqual(entries.get("mac-one"), { agentToken: TOKEN_ONE });
  assert.deepEqual(
    s.config.targets.map((t) => t.id),
    ["mac-one", "t-00000001"],
  );
  assert.equal(s.config.targets[1].port, 18471);
  assert.equal(s.credentials.protocols.get("t-00000001"), "agent");
  assert.deepEqual(s.logs, [`manage add t-00000001 by ${LOGIN}: ok`]);
});

test("two adds started together both land in the file", async (t) => {
  const s = await setup(t);
  const [a, b] = await Promise.all([
    s.manager.add(LOGIN, {
      name: "Mac A",
      kind: "mac-agent",
      hostname: "100.64.0.20",
    }),
    s.manager.add(LOGIN, {
      name: "Mac B",
      kind: "mac-agent",
      hostname: "100.64.0.20",
    }),
  ]);
  assert.notEqual(a.id, b.id);
  const file = await readJson(s.configPath);
  assert.deepEqual(
    file.targets.map((t) => t.id),
    ["mac-one", a.id, b.id],
  );
  assert.deepEqual(
    s.config.targets.map((t) => t.id),
    ["mac-one", a.id, b.id],
  );
});

test("a hand edit made after start survives a rename", async (t) => {
  const s = await setup(t);
  const edited = {
    ...JSON.parse(s.original),
    guacdPort: 4823,
    targets: [macOne, macTwo],
  };
  await writeFile(s.configPath, `${JSON.stringify(edited, null, 2)}\n`);
  const renamed = await s.manager.rename(LOGIN, "mac-one", "Desk Mac");
  assert.equal(renamed.name, "Desk Mac");
  const file = await readJson(s.configPath);
  assert.equal(file.guacdPort, 4823);
  assert.deepEqual(file.targets, [{ ...macOne, name: "Desk Mac" }, macTwo]);
  assert.deepEqual(
    s.config.targets.map((t) => [t.id, t.name]),
    [
      ["mac-one", "Desk Mac"],
      ["mac-two", "Mac Two"],
    ],
  );
  assert.deepEqual(s.logs, [`manage rename mac-one by ${LOGIN}: ok`]);
});

test("a credential file with mode 644 fails setCredential and remove with 500", async (t) => {
  const s = await setup(t, { targets: [macOne, macTwo] });
  await chmod(s.credentialsFile, 0o644);
  for (const run of [
    () => s.manager.setCredential(LOGIN, "mac-one", { agentToken: TOKEN_NEW }),
    () => s.manager.remove(LOGIN, "mac-two"),
  ]) {
    s.logs.length = 0;
    await assert.rejects(run(), (error) => {
      assert.equal(error.status, 500);
      assert.equal(error.message, "서버에 저장하지 못했습니다.");
      return true;
    });
    assert.equal(await readFile(s.configPath, "utf8"), s.original);
    assert.equal(s.logs.length, 1);
    assert.match(s.logs[0], /failed at credential/);
    for (const token of [TOKEN_ONE, TOKEN_TWO, TOKEN_NEW])
      assert.equal(s.logs[0].includes(token), false);
  }
  assert.deepEqual(
    s.config.targets.map((t) => t.id),
    ["mac-one", "mac-two"],
  );
});

test("setCredential replaces only that target's entry", async (t) => {
  const s = await setup(t, { targets: [macOne, macTwo] });
  await s.manager.setCredential(LOGIN, "mac-two", { agentToken: TOKEN_NEW });
  const entries = await readCredentialFile(s.credentialsFile);
  assert.deepEqual(entries.get("mac-two"), { agentToken: TOKEN_NEW });
  assert.deepEqual(entries.get("mac-one"), { agentToken: TOKEN_ONE });
  assert.deepEqual(s.logs, [`manage credential mac-two by ${LOGIN}: ok`]);
});

test("remove deletes the key and the target; the last target cannot be removed", async (t) => {
  const s = await setup(t, { targets: [macOne, macTwo] });
  await s.manager.remove(LOGIN, "mac-two");
  assert.deepEqual((await readJson(s.configPath)).targets, [macOne]);
  const entries = await readCredentialFile(s.credentialsFile);
  assert.deepEqual([...entries.keys()], ["mac-one"]);
  assert.deepEqual(
    s.config.targets.map((t) => t.id),
    ["mac-one"],
  );
  assert.equal(s.credentials.protocols.has("mac-two"), false);
  assert.deepEqual(s.logs, [`manage delete mac-two by ${LOGIN}: ok`]);

  const configBefore = await readFile(s.configPath);
  const prevBefore = await readFile(`${s.configPath}.prev`);
  const credentialsBefore = await readFile(s.credentialsFile);
  s.logs.length = 0;
  await assert.rejects(s.manager.remove(LOGIN, "mac-one"), { status: 409 });
  assert.deepEqual(await readFile(s.configPath), configBefore);
  assert.deepEqual(await readFile(`${s.configPath}.prev`), prevBefore);
  assert.deepEqual(await readFile(s.credentialsFile), credentialsBefore);
  assert.deepEqual(
    s.config.targets.map((t) => t.id),
    ["mac-one"],
  );
  assert.deepEqual(s.logs, [
    `manage delete mac-one by ${LOGIN}: refused (409)`,
  ]);
});

test("a key that cannot be saved after the add keeps the target and says so", async (t) => {
  const s = await setup(t, { credentialDir: "creds" });
  // Readable but not writable: the ID check reads it, the key write fails.
  await chmod(join(s.dir, "creds"), 0o500);
  await assert.rejects(
    s.manager.add(LOGIN, {
      name: "Mac Three",
      kind: "mac-agent",
      hostname: "100.64.0.20",
      credential: { agentToken: TOKEN_NEW },
    }),
    {
      status: 500,
      message:
        "기기는 추가했지만 로그인 정보를 저장하지 못했습니다. 기기 관리에서 다시 입력하세요.",
    },
  );
  assert.deepEqual(
    (await readJson(s.configPath)).targets.map((t) => t.id),
    ["mac-one", "t-00000001"],
  );
  assert.deepEqual(
    s.config.targets.map((t) => t.id),
    ["mac-one", "t-00000001"],
  );
  assert.equal(s.logs.length, 1);
  assert.match(
    s.logs[0],
    /^manage add t-00000001 by .*: failed at credential \(EACCES\)$/,
  );
  assert.equal(s.logs[0].includes(TOKEN_NEW), false);
});
