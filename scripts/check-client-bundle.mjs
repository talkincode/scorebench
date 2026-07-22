import { readdir, readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import path from "node:path";

const clientRoot = path.resolve(".svelte-kit/output/client");
const manifestPath = path.join(clientRoot, ".vite/manifest.json");

// Budgets are intentionally close to the 2026-07-23 production baseline.
// Raise one only with an explained, reviewed change to the corresponding
// feature; a successful Vite build alone is not a size acceptance signal.
const budgets = {
  total: { raw: 1_000_000, gzip: 300_000 },
  largest: { raw: 590_000, gzip: 150_000 },
  entries: {
    "src/lib/spectrum/three/mood.ts": { raw: 22_000, gzip: 9_000 },
    "src/lib/spectrum/three/voyage.ts": { raw: 85_000, gzip: 28_000 },
  },
};

async function listJavaScript(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await listJavaScript(target)));
    else if (entry.isFile() && entry.name.endsWith(".js")) found.push(target);
  }
  return found;
}

function measure(buffer) {
  return { raw: buffer.length, gzip: gzipSync(buffer, { level: 9 }).length };
}

function formatBytes(value) {
  return `${(value / 1024).toFixed(1)} KiB`;
}

function assertBudget(label, actual, budget, failures) {
  for (const kind of ["raw", "gzip"]) {
    if (actual[kind] > budget[kind]) {
      failures.push(
        `${label} ${kind}: ${formatBytes(actual[kind])} > ${formatBytes(budget[kind])}`,
      );
    }
  }
}

let manifest;
try {
  manifest = JSON.parse(await readFile(manifestPath, "utf8"));
} catch (error) {
  console.error(`bundle budget requires a production build at ${manifestPath}`);
  throw error;
}

const files = await listJavaScript(path.join(clientRoot, "_app/immutable"));
const measurements = new Map();
for (const file of files) measurements.set(file, measure(await readFile(file)));

const total = [...measurements.values()].reduce(
  (sum, current) => ({ raw: sum.raw + current.raw, gzip: sum.gzip + current.gzip }),
  { raw: 0, gzip: 0 },
);
const [largestPath, largest] = [...measurements.entries()].sort(
  ([, left], [, right]) => right.raw - left.raw,
)[0];

const failures = [];
assertBudget("all client JavaScript", total, budgets.total, failures);
assertBudget(
  `largest chunk (${path.relative(clientRoot, largestPath)})`,
  largest,
  budgets.largest,
  failures,
);

for (const [source, budget] of Object.entries(budgets.entries)) {
  const entry = manifest[source];
  if (!entry?.file) {
    failures.push(`${source}: missing from Vite manifest`);
    continue;
  }
  const file = path.join(clientRoot, entry.file);
  const actual = measurements.get(file) ?? measure(await readFile(file));
  assertBudget(source, actual, budget, failures);
  console.log(
    `${source}: ${formatBytes(actual.raw)} raw / ${formatBytes(actual.gzip)} gzip`,
  );
}

console.log(
  `client JavaScript: ${formatBytes(total.raw)} raw / ${formatBytes(total.gzip)} gzip`,
);
console.log(
  `largest chunk: ${formatBytes(largest.raw)} raw / ${formatBytes(largest.gzip)} gzip`,
);

if (failures.length) {
  console.error("bundle budget exceeded:\n- " + failures.join("\n- "));
  process.exitCode = 1;
} else {
  console.log("bundle budget passed");
}
