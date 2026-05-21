#!/usr/bin/env node

import { buildPluginArtifacts } from "./build-plugin-artifacts.js";

await buildPluginArtifacts({ buildDeps: process.argv.includes("--build-deps") });
console.log("Generated plugin artifact layout under plugins/.");