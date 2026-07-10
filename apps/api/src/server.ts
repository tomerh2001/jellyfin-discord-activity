import { buildApp } from "./app.js";
import { loadEnv } from "./env.js";

const env = loadEnv();
const app = await buildApp(env);

try {
  await app.listen({ host: env.HOST, port: env.PORT });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
