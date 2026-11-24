import { randomBytes } from "node:crypto";

export class ManageError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function targetForKind(kind, input, id) {
  const name = String(input.name).trim();
  if (kind === "mac-agent")
    return {
      id,
      name,
      platform: "mac",
      protocol: "agent",
      hostname: input.hostname,
    };
  if (kind === "ubuntu-local")
    return {
      id,
      name,
      platform: "linux",
      protocol: "rdp",
      profile: "gnome-remote-login",
      hostname: "127.0.0.1",
      port: 3389,
      security: "nla",
      ignoreCertificate: true,
      persistent: true,
    };
  throw new ManageError(400, "입력값을 확인하세요.");
}

export function newTargetId(taken, random = (n) => randomBytes(n)) {
  for (;;) {
    const id = `t-${Buffer.from(random(4)).toString("hex")}`;
    if (!taken.has(id)) return id;
  }
}

export function applyTargetOp(targets, op) {
  const copy = targets.map((t) => ({ ...t }));
  if (op.type === "add") {
    if (
      op.target.profile === "gnome-remote-login" &&
      copy.some((t) => t.profile === "gnome-remote-login")
    )
      throw new ManageError(409, "이 서버는 이미 목록에 있습니다.");
    return [...copy, { ...op.target }];
  }
  const index = copy.findIndex((t) => t.id === op.id);
  if (index < 0) throw new ManageError(404, "기기를 찾을 수 없습니다.");
  if (op.type === "rename") {
    copy[index].name = op.name;
    return copy;
  }
  if (op.type === "delete") {
    if (copy.length === 1)
      throw new ManageError(409, "마지막 기기는 지울 수 없습니다.");
    copy.splice(index, 1);
    return copy;
  }
  throw new ManageError(400, "입력값을 확인하세요.");
}

const MESSAGES = new Map([
  ["Invalid target name.", "이름은 1-100자로 입력하세요."],
  [
    "An agent target must use the Mac's Tailscale IP.",
    "Mac의 Tailscale 주소(100.x.y.z)를 입력하세요.",
  ],
  [
    "Targets must use a Tailscale IP or loopback.",
    "Mac의 Tailscale 주소(100.x.y.z)를 입력하세요.",
  ],
  ["Configure 1–100 targets.", "기기는 100대까지 둘 수 있습니다."],
]);

export function koreanConfigError(error) {
  return new ManageError(
    400,
    MESSAGES.get(error.message) ?? "입력값을 확인하세요.",
  );
}
