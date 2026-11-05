import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/infrastructure/db/schema/*.ts",
  out: "./src/infrastructure/db/migrations",
  dialect: "postgresql",
  casing: "snake_case",
  dbCredentials: { url: process.env.TRAILIC_DATABASE_URL ?? "" },
});
