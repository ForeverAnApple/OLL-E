import type { Config } from "drizzle-kit";

export default {
  schema: "./src/store/schema.ts",
  out: "./src/store/migrations",
  dialect: "sqlite",
} satisfies Config;
