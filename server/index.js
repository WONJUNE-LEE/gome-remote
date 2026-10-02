import { loadConfig } from "./config.js";
import { createGateway } from "./gateway.js";

const config = await loadConfig(
  process.env.GOME_REMOTE_CONFIG || "config.local.json",
);
const gateway = createGateway(config);
gateway.server.listen(config.port, config.listenHost, () => {
  console.log(
    `Gome Remote is listening on ${config.listenHost}:${config.port}`,
  );
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await gateway.close();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
