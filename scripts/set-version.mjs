import { readFile, writeFile } from "node:fs/promises";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("usage: npm run version:set -- <semver>");
  process.exit(2);
}

const path = new URL("../src-tauri/tauri.conf.json", import.meta.url);
const config = JSON.parse(await readFile(path, "utf8"));
config.version = version;
await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
console.log(`src-tauri/tauri.conf.json version set to ${version}`);
