import { cp, mkdir, readdir } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = resolve(packageDir, "../core-daemon/storage/schema");
const targetDir = resolve(packageDir, "dist/storage/schema");

await mkdir(targetDir, { recursive: true });

for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
  if (entry.isFile() && extname(entry.name) === ".sql") {
    await cp(resolve(sourceDir, entry.name), resolve(targetDir, entry.name));
  }
}
