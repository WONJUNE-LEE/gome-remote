const fs = require("node:fs/promises");
const path = require("node:path");

// The app's only setting is the gateway origin. It is not a secret, so it lives in a
// plain JSON file and is validated again whenever it is read.
const BAD_ADDRESS = "서버 주소를 확인해 주세요.";
const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i;

function gatewayOrigin(raw) {
  if (typeof raw !== "string") throw new Error("서버 주소를 입력해주세요.");
  const text = raw.trim();
  // Accept "host.tailnet.ts.net:8450" typed without a scheme.
  let url;
  try {
    url = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`,
    );
  } catch {
    throw new Error(BAD_ADDRESS);
  }
  const tailnet =
    url.protocol === "https:" &&
    url.hostname.endsWith(".ts.net") &&
    url.hostname.length > ".ts.net".length;
  const loopback =
    url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port !== "";
  if (!tailnet && !loopback)
    throw new Error("Tailscale HTTPS 주소(…ts.net)를 입력해주세요.");
  // Every label must be non-empty and neither start nor end with "-".
  if (tailnet && !url.hostname.split(".").every((label) => LABEL.test(label)))
    throw new Error(BAD_ADDRESS);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("서버 주소만 입력해주세요.");
  return url.origin;
}

class AddressStore {
  constructor(file) {
    this.file = file;
  }
  // Returns the saved origin, or "" when nothing valid is saved.
  async load() {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, "utf8"));
      return gatewayOrigin(saved.gateway);
    } catch {
      return "";
    }
  }
  async save(origin) {
    const checked = gatewayOrigin(origin);
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify({ gateway: checked })}\n`);
    await fs.rename(temp, this.file);
    return checked;
  }
}

module.exports = { AddressStore, gatewayOrigin };
