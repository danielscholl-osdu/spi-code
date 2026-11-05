// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { createInterface } from "node:readline";
import { openRunStore } from "../../dist/store/store.js";

const [path, at] = process.argv.slice(2);
const store = openRunStore(path);
let count = 0;

for await (const command of createInterface({ input: process.stdin })) {
  if (command !== "append") throw new Error(`Unexpected command: ${command}`);
  count += 1;
  const seq = store.appendEvent("crash", { kind: "text", message: `event ${count}` }, at);
  process.stdout.write(`committed ${seq}\n`);
}
