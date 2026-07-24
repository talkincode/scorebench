import { readFile } from "node:fs/promises";

async function read(relPath) {
  return readFile(new URL(relPath, import.meta.url), "utf8");
}

function extract(label, source, pattern) {
  const match = source.match(pattern);
  if (!match) {
    throw new Error(`${label}: version field not found`);
  }
  return match[1];
}

const lock = JSON.parse(await read("../package-lock.json"));
const versions = {
  "src-tauri/tauri.conf.json": JSON.parse(await read("../src-tauri/tauri.conf.json")).version,
  "package.json": JSON.parse(await read("../package.json")).version,
  "package-lock.json": lock.version,
  'package-lock.json packages[""]': lock.packages[""].version,
  "src-tauri/Cargo.toml": extract(
    "src-tauri/Cargo.toml",
    await read("../src-tauri/Cargo.toml"),
    /^version = "([^"]+)"$/m,
  ),
  "src-tauri/Cargo.lock": extract(
    "src-tauri/Cargo.lock",
    await read("../src-tauri/Cargo.lock"),
    /\[\[package\]\]\nname = "scorebench"\nversion = "([^"]+)"/,
  ),
};

const unique = [...new Set(Object.values(versions))];
if (unique.length !== 1) {
  throw new Error(`version drift across sources: ${JSON.stringify(versions, null, 2)}`);
}

const expected = `v${unique[0]}`;
if (process.env.GITHUB_REF_NAME !== expected) {
  throw new Error(`tag ${process.env.GITHUB_REF_NAME ?? "(missing)"} does not match ${expected}`);
}
