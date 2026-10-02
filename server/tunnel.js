import net from "node:net";
import { StringDecoder } from "node:string_decoder";
import Parser from "../vendor/parser.js";

const MAX_QUEUE = 4 * 1024 * 1024;
export const instruction = (...parts) =>
  Parser.toInstruction(parts.map((p) => (p == null ? "" : String(p))));

export function bridge(ws, connection, port) {
  const socket = net.connect(port, "127.0.0.1");
  const decoder = new StringDecoder("utf8");
  const parser = new Parser();
  let phase = "args";
  let closed = false;
  let handshakeBytes = 0;
  const timeout = setTimeout(
    () => fail("Desktop handshake timed out."),
    15_000,
  );
  function send(data) {
    if (closed || ws.readyState !== 1) return;
    if (ws.bufferedAmount + Buffer.byteLength(data) > MAX_QUEUE) return close();
    ws.send(data, (error) => {
      if (error) close();
    });
  }
  function write(data) {
    if (closed) return;
    if (socket.writableLength + Buffer.byteLength(data) > MAX_QUEUE)
      return close();
    socket.write(data);
  }
  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(timeout);
    socket.destroy();
    if (ws.readyState === 1) ws.close(1000, "Desktop connection closed.");
  }
  function fail(message) {
    send(instruction("error", message, 0x0200));
    close();
  }
  parser.oninstruction = (opcode, args) => {
    if (closed) return;
    if (phase === "args") {
      if (opcode === "error") {
        send(instruction(opcode, ...args));
        close();
        return;
      }
      if (opcode !== "args") return fail("Invalid desktop handshake.");
      phase = "ready";
      const settings = connection.settings;
      write(instruction("size", settings.width, settings.height, settings.dpi));
      write(instruction("audio"));
      write(instruction("video"));
      write(instruction("image", "image/png", "image/jpeg"));
      if (args.some((arg) => arg.startsWith("VERSION_")))
        write(instruction("timezone", "Asia/Seoul"));
      write(
        instruction(
          "connect",
          ...args.map((arg) =>
            arg.startsWith("VERSION_") ? "VERSION_1_1_0" : settings[arg],
          ),
        ),
      );
      // The adapter retains no long-lived credential copy after authentication parameters are sent.
      delete settings.password;
      return;
    }
    if (phase === "ready") {
      if (opcode === "error") {
        send(instruction(opcode, ...args));
        close();
        return;
      }
      if (opcode !== "ready") return fail("Desktop did not become ready.");
      phase = "connected";
      clearTimeout(timeout);
      send(instruction("", args[0]));
      return;
    }
    send(instruction(opcode, ...args));
  };
  socket.setTimeout(90_000, () => fail("Desktop connection timed out."));
  socket.on("connect", () => write(instruction("select", connection.type)));
  socket.on("data", (chunk) => {
    if (phase !== "connected") {
      handshakeBytes += chunk.length;
      if (handshakeBytes > 128 * 1024)
        return fail("Desktop handshake too large.");
    }
    try {
      parser.receive(decoder.write(chunk));
    } catch {
      fail("Invalid desktop data.");
    }
  });
  socket.on("error", () => fail("Desktop service unavailable."));
  socket.on("close", close);
  ws.on("message", (data, binary) => {
    if (binary || phase !== "connected") return close();
    write(data);
  });
  ws.on("close", close);
  ws.on("error", close);
  return close;
}
