import { createApp } from "./app";
import { loadRuntimeConfig } from "./config";
import { fetchOfficial } from "./http/fetchOfficial";
import { errorMessage, logError, logInfo } from "./log";
import { createResultsService } from "./resultsService";

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  const service = createResultsService({
    config,
    fetchOfficial: (url) => fetchOfficial(url),
  });
  await service.warm();
  service.start();
  const app = createApp(service, config);
  const server = app.listen(config.port, () => {
    logInfo("server_started", { port: config.port, mode: config.mode });
  });
  server.on("error", (error) => {
    logError("server_listen_failed", { message: errorMessage(error) });
    process.exit(1);
  });
}

if (require.main === module) {
  main().catch((error: unknown) => {
    logError("startup_failed", { message: errorMessage(error) });
    process.exit(1);
  });
}
