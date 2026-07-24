import { readFile, writeFile } from "node:fs/promises";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("usage: npm run version:set -- <semver>");
  process.exit(2);
}

async function updateJson(relPath, label, mutate) {
  const path = new URL(relPath, import.meta.url);
  const config = JSON.parse(await readFile(path, "utf8"));
  mutate(config);
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`${label} version set to ${version}`);
}

async function updateText(relPath, label, pattern) {
  const path = new URL(relPath, import.meta.url);
  const source = await readFile(path, "utf8");
  if (!pattern.test(source)) {
    throw new Error(`${label}: version field not found`);
  }
  await writeFile(path, source.replace(pattern, `$1${version}$2`));
  console.log(`${label} version set to ${version}`);
}

await updateJson("../src-tauri/tauri.conf.json", "src-tauri/tauri.conf.json", (config) => {
  config.version = version;
});
await updateJson("../package.json", "package.json", (config) => {
  config.version = version;
});
await updateJson("../package-lock.json", "package-lock.json", (lock) => {
  lock.version = version;
  lock.packages[""].version = version;
});
await updateText(
  "../src-tauri/Cargo.toml",
  "src-tauri/Cargo.toml",
  /^(version = ")[^"]+(")$/m,
);
await updateText(
  "../src-tauri/Cargo.lock",
  "src-tauri/Cargo.lock",
  /(\[\[package\]\]\nname = "scorebench"\nversion = ")[^"]+(")/,
);
