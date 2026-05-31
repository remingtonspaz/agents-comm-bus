import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = resolve(packageDir, "../core-daemon/storage/schema");
const targetDir = resolve(packageDir, "dist/core-daemon/storage/schema");
const installShimDir = resolve(packageDir, "dist/hosts/common/install");

await mkdir(targetDir, { recursive: true });

function normalizeEol(text) {
  return text.replace(/\r\n?/g, "\n");
}

for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
  if (entry.isFile() && extname(entry.name) === ".sql") {
    const source = resolve(sourceDir, entry.name);
    const target = resolve(targetDir, entry.name);
    await writeFile(target, normalizeEol(await readFile(source, "utf8")), "utf8");
  }
}

await mkdir(installShimDir, { recursive: true });
await writeFile(
  resolve(installShimDir, "entry-ensures.js"),
  normalizeEol(`export { entryEnsures } from "../../../../../hosts/common/install/entry-ensures.js";\n`),
  "utf8",
);
