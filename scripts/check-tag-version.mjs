import { readFile } from "node:fs/promises";

const config = JSON.parse(
  await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
);
const expected = `v${config.version}`;
if (process.env.GITHUB_REF_NAME !== expected) {
  throw new Error(`tag ${process.env.GITHUB_REF_NAME ?? "(missing)"} does not match ${expected}`);
}
