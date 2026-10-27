/**
 * Runs the regression tests (src/lib/*.test.ts) with Node's test runner.
 * jiti loads TypeScript and maps the "@/" import alias to ./src.
 *   npm test
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const src = resolve("src").split("\\").join("/");
const files = readdirSync("src/lib").filter((f) => f.endsWith(".test.ts")).map((f) => join("src/lib", f));
const r = spawnSync(process.execPath, ["--import", "jiti/register", "--test", ...files], {
  stdio: "inherit",
  env: { ...process.env, JITI_ALIAS: JSON.stringify({ "@/": `${src}/` }) },
});
process.exit(r.status ?? 1);
