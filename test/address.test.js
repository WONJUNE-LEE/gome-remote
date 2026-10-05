import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const { AddressStore, gatewayOrigin } = createRequire(import.meta.url)(
  "../desktop/address.cjs",
);

test("the address must be a Tailscale HTTPS origin or loopback http with a port", () => {
  assert.equal(
    gatewayOrigin("https://server.tail123.ts.net:8450/"),
    "https://server.tail123.ts.net:8450",
  );
  assert.equal(
    gatewayOrigin("  server.tail123.ts.net:8450  "),
    "https://server.tail123.ts.net:8450",
    "a missing scheme is filled in",
  );
  assert.equal(
    gatewayOrigin("http://127.0.0.1:38989"),
    "http://127.0.0.1:38989",
  );
  for (const bad of [
    "https://evil.example",
    "http://server.tail123.ts.net",
    "https://server.tail123.ts.net.evil.example",
    "https://.ts.net",
    "https://..ts.net",
    "https://a..ts.net",
    "https://-x.tail123.ts.net",
    "https://x-.tail123.ts.net",
    "https://a.-x.tail123.ts.net",
    "https://a.x-.tail123.ts.net",
    "http://127.0.0.1",
    "http://localhost:38989",
    "https://user:pass@server.tail123.ts.net",
    "https://server.tail123.ts.net/path",
    "https://server.tail123.ts.net/?q=1",
    "https://server.tail123.ts.net/#frag",
    "ftp://server.tail123.ts.net",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "",
    "   ",
    undefined,
  ])
    assert.throws(() => gatewayOrigin(bad), Error, String(bad));
});

test("the saved address round-trips, rewrites atomically and ignores invalid files", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gr-addr-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "nested", "gateway.json");
  const store = new AddressStore(file);
  assert.equal(await store.load(), "", "nothing saved yet");
  assert.equal(
    await store.save("server.tail123.ts.net:8450"),
    "https://server.tail123.ts.net:8450",
  );
  assert.equal(await store.load(), "https://server.tail123.ts.net:8450");
  await store.save("https://other.tail123.ts.net");
  assert.equal(await store.load(), "https://other.tail123.ts.net");
  assert.deepEqual(await readdir(join(dir, "nested")), ["gateway.json"]);
  await assert.rejects(store.save("https://evil.example"));
  assert.equal(await store.load(), "https://other.tail123.ts.net");
  for (const content of [
    "not json",
    '{"gateway":"https://evil.example"}',
    "{}",
  ]) {
    await writeFile(file, content);
    assert.equal(await store.load(), "", content);
  }
  await store.save("server.tail123.ts.net:8450");
  assert.match(
    await readFile(file, "utf8"),
    /"gateway":"https:\/\/server\.tail123\.ts\.net:8450"/,
  );
});

test("malformed input gives the Korean message, never a raw URL error", () => {
  for (const bad of [
    "http://[",
    "https://",
    "https:// bad host.tail123.ts.net",
    "https://a b.tail123.ts.net",
    "https://%zz.tail123.ts.net",
    "..ts.net",
    "a..ts.net",
    "-x.tail123.ts.net",
    "https://exa mple",
    "///",
  ])
    assert.throws(
      () => gatewayOrigin(bad),
      (error) => {
        assert.match(error.message, /[가-힣]/, bad);
        assert.doesNotMatch(error.message, /Invalid URL|TypeError/, bad);
        return true;
      },
      bad,
    );
  assert.throws(() => gatewayOrigin("http://["), {
    message: "서버 주소를 확인해 주세요.",
  });
  assert.equal(
    gatewayOrigin("https://my-box.tail123.ts.net"),
    "https://my-box.tail123.ts.net",
  );
});
