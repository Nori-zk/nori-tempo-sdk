// Hardhat 3.4.5 shuffles the contract declarations in the generated
// hardhat.d.ts and index.ts on every compile (see ethereum/stabilize-types.mjs).
// This script sorts the unstable lines after each compile so that the output
// is reproducible and git-clean checks in CI stay quiet.

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const typesDir = join(process.argv[2] || ".", "types", "ethers-contracts");

// index.ts: sort all lines after "export * as factories"
const indexPath = join(typesDir, "index.ts");
const indexLines = readFileSync(indexPath, "utf8").split("\n");
const factoriesIdx = indexLines.findIndex(
  (l) => l.includes("export *") && l.includes("factories")
);
if (factoriesIdx !== -1) {
  const before = indexLines.slice(0, factoriesIdx + 1);
  const after = indexLines.slice(factoriesIdx + 1).filter((l) => l.trim());
  after.sort();
  writeFileSync(indexPath, [...before, ...after, ""].join("\n"));
}

// hardhat.d.ts: sort consecutive contract-specific lines within each block
const dtsPath = join(typesDir, "hardhat.d.ts");
const dtsLines = readFileSync(dtsPath, "utf8").split("\n");
const result = [];
let group = [];

function flushGroup() {
  if (group.length > 0) {
    // Normalize: strip leading whitespace, add consistent 2-space indent, then sort.
    // Hardhat also randomizes which line gets the leading indent.
    group = group.map((l) => "  " + l.trimStart());
    group.sort();
    result.push(...group);
    group = [];
  }
}

const contractLineRe =
  /^\s*(getContractFactory|getContractAt|deployContract)\(name:\s*'/;
for (const line of dtsLines) {
  if (contractLineRe.test(line)) {
    group.push(line);
  } else {
    flushGroup();
    result.push(line);
  }
}
flushGroup();
writeFileSync(dtsPath, result.join("\n"));
