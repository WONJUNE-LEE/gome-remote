const fs = require("node:fs/promises");
const path = require("node:path");

class Vault {
  constructor(file, crypto, platform = process.platform) {
    this.file = file;
    this.crypto = crypto;
    this.platform = platform;
    this.value = { gateway: "", token: "", credentials: {} };
    this.pending = Promise.resolve();
  }
  async available() {
    return (
      (await this.crypto.isAsyncEncryptionAvailable()) &&
      !(
        this.platform === "linux" &&
        !["gnome-libsecret", "kwallet", "kwallet5", "kwallet6"].includes(
          this.crypto.getSelectedStorageBackend(),
        )
      )
    );
  }
  async load() {
    let bytes;
    try {
      bytes = await fs.readFile(this.file);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (!(await this.available()))
      throw new Error(
        "OS 보안 저장소를 잠금 해제한 뒤 앱을 다시 실행해주세요.",
      );
    this.value = JSON.parse(
      (await this.crypto.decryptStringAsync(bytes)).result,
    );
  }
  async save() {
    const snapshot = JSON.stringify(this.value);
    // Serialize writes so an older async save cannot overwrite a newer one.
    const save = this.pending.then(async () => {
      if (!(await this.available())) return false;
      const encrypted = await this.crypto.encryptStringAsync(snapshot);
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      await fs.writeFile(`${this.file}.tmp`, encrypted, { mode: 0o600 });
      await fs.rename(`${this.file}.tmp`, this.file);
      return true;
    });
    this.pending = save.catch(() => {});
    return save;
  }
}

function gatewayOrigin(raw) {
  const url = new URL(raw);
  const local = url.protocol === "http:" && url.hostname === "127.0.0.1";
  if (
    !local &&
    !(url.protocol === "https:" && url.hostname.endsWith(".ts.net"))
  )
    throw new Error("Tailscale HTTPS 주소를 입력해주세요.");
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

module.exports = { Vault, gatewayOrigin };
