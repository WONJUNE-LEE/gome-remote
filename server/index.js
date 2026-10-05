import { loadConfig } from "./config.js";
import { CredentialStore } from "./credentials.js";
import { createGateway } from "./gateway.js";
import { forwardLoopback, listenOnSocket, removeSocket } from "./listen.js";

async function start() {
  const config = await loadConfig(
    process.env.GOME_REMOTE_CONFIG || "config.local.json",
  );
  const credentials = new CredentialStore(config.credentialsFile);
  // Refuse to start on a credentials file with the wrong mode, owner or shape.
  const known = await credentials.load();
  const unknown = [...known.keys()].filter(
    (id) => !config.targets.some((t) => t.id === id),
  );
  if (unknown.length)
    console.warn(`Credentials exist for unconfigured targets: ${unknown}`);
  const gateway = createGateway(config, { credentials });
  await listenOnSocket(gateway.server, config.socketPath);
  let relay;
  if (config.devLogin) {
    relay = await forwardLoopback(
      config.socketPath,
      Number(new URL(config.publicOrigin).port),
    );
    console.warn(
      `Development login "${config.devLogin}" is active on ${config.publicOrigin}.`,
    );
  }
  console.log(`Gome Remote is listening on ${config.socketPath}`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    relay?.close();
    await gateway.close();
    await removeSocket(config.socketPath);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

try {
  await start();
} catch (error) {
  console.error(`Gome Remote refused to start: ${error.message}`);
  process.exit(1);
}
