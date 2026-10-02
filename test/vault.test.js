import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import vaultModule from "../desktop/vault.cjs";
const { Vault, gatewayOrigin } = vaultModule;

test("gateway URL accepts only Tailscale HTTPS or local development", () => {
  assert.equal(
    gatewayOrigin("https://server.tail123.ts.net:8449/"),
    "https://server.tail123.ts.net:8449",
  );
  for (const url of [
    "https://evil.example",
    "http://server.tail123.ts.net",
    "https://server.tail123.ts.net.evil.example",
    "https://user:pass@server.ts.net",
    "https://server.ts.net/path",
  ])
    assert.throws(() => gatewayOrigin(url));
});

test("vault writes encrypted bytes, serializes concurrent updates, and refuses basic_text", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gome-remote-vault-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const key = randomBytes(32);
  const crypto = {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => "gnome-libsecret",
    async encryptStringAsync(value) {
      if (value.includes("first-secret"))
        await new Promise((resolve) => setTimeout(resolve, 10));
      const iv = randomBytes(16);
      const cipher = createCipheriv("aes-256-cbc", key, iv);
      return Buffer.concat([iv, cipher.update(value), cipher.final()]);
    },
    async decryptStringAsync(value) {
      const cipher = createDecipheriv(
        "aes-256-cbc",
        key,
        value.subarray(0, 16),
      );
      return {
        result: Buffer.concat([
          cipher.update(value.subarray(16)),
          cipher.final(),
        ]).toString(),
      };
    },
  };
  const file = join(dir, "vault.enc");
  const vault = new Vault(file, crypto, "linux");
  vault.value.token = "first-secret";
  const first = vault.save();
  vault.value.token = "second-secret";
  const second = vault.save();
  await Promise.all([first, second]);
  assert.equal(
    (await readFile(file)).includes(Buffer.from("second-secret")),
    false,
  );
  const reloaded = new Vault(file, crypto, "linux");
  await reloaded.load();
  assert.equal(reloaded.value.token, "second-secret");
  const unavailable = new Vault(
    join(dir, "unprotected.enc"),
    { ...crypto, getSelectedStorageBackend: () => "basic_text" },
    "linux",
  );
  assert.equal(await unavailable.save(), false);
  await assert.rejects(readFile(unavailable.file), { code: "ENOENT" });
});
