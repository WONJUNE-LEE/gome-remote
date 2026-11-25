import assert from "node:assert/strict";
import test from "node:test";
import {
  ManageError,
  applyTargetOp,
  newTargetId,
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
  hostname: "100.64.0.10",
};

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
