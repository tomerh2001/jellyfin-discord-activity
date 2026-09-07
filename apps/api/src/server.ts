import { buildApp } from "./app.js";
import { loadEnv } from "./env.js";
import { loadSecretFiles } from "./services/secretFiles.js";

const env = loadEnv(loadSecretFiles());
const app = await buildApp(env);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().catch(() => { process.exitCode = 1; });
  });
}

try {
  await app.listen({ host: env.HOST, port: env.PORT });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
