#!/usr/bin/env node
const message = "agents-comm-bus adapter scaffold for discord is present in the AGE-7 release layout, but the runtime implementation has not landed yet.";
export const scaffold = { kind: "adapter", comm: "discord" };
export function notImplemented() {
  throw new Error(message);
}
if (import.meta.url === new URL(process.argv[1], 'file://').href) {
  console.error(message);
  process.exit(1);
}
