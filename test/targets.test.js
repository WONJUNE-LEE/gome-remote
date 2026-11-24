import assert from "node:assert/strict";
import test from "node:test";
import {
  ManageError,
  applyTargetOp,
  koreanConfigError,
  newTargetId,
  targetForKind,
} from "../server/targets.js";

const ubuntu = {
  id: "t-00000001",
  name: "서버",
  platform: "linux",
  protocol: "rdp",
  profile: "gnome-remote-login",
  hostname: "127.0.0.1",
  port: 3389,
  security: "nla",
  ignoreCertificate: true,
  persistent: true,
};
const mac = {
  id: "t-00000002",
  name: "Mac",
  platform: "mac",
  protocol: "agent",
  hostname: "100.64.0.2",
};

test("targetForKind builds the ubuntu-local target", () => {
  assert.deepEqual(
    targetForKind("ubuntu-local", { name: " 서버 " }, "t-00000001"),
    ubuntu,
  );
});

test("targetForKind builds a mac-agent target without a port", () => {
  assert.deepEqual(
    targetForKind(
      "mac-agent",
      { name: "Mac", hostname: "100.64.0.2" },
      "t-00000002",
    ),
    mac,
  );
});

test("newTargetId skips taken ids", () => {
  const bytes = [
    Buffer.from("aaaaaaaa", "hex"),
    Buffer.from("bbbbbbbb", "hex"),
  ];
  assert.equal(
    newTargetId(new Set(["t-aaaaaaaa"]), () => bytes.shift()),
    "t-bbbbbbbb",
  );
});

test("applyTargetOp rejects a second ubuntu-local target", () => {
  assert.throws(
    () => applyTargetOp([ubuntu], { type: "add", target: { ...ubuntu, id: "t-00000003" } }),
    (e) => e instanceof ManageError && e.status === 409,
  );
});

test("applyTargetOp refuses to delete the last target", () => {
  assert.throws(
    () => applyTargetOp([mac], { type: "delete", id: mac.id }),
    (e) => e.status === 409,
  );
});

test("applyTargetOp rename of an unknown id is 404", () => {
  assert.throws(
    () => applyTargetOp([mac], { type: "rename", id: "t-ffffffff", name: "x" }),
    (e) => e.status === 404,
  );
});

test("applyTargetOp rename returns new objects and leaves the input alone", () => {
  const input = [mac, ubuntu];
  const out = applyTargetOp(input, { type: "rename", id: mac.id, name: "New" });
  assert.equal(out[0].name, "New");
  assert.notEqual(out[0], mac);
  assert.notEqual(out[1], ubuntu);
  assert.equal(input.length, 2);
  assert.equal(input[0], mac);
  assert.equal(mac.name, "Mac");
});

test("koreanConfigError maps validateConfig messages", () => {
  const e = koreanConfigError(new Error("Invalid target name."));
  assert.equal(e.status, 400);
  assert.equal(e.message, "이름은 1-100자로 입력하세요.");
});
