import { logStep, runCommand } from "./lib/harness.mjs";

const started = Date.now();
const results = [];

async function run(label, command, args, options) {
  logStep(`running ${label}`);
  const durationMs = await runCommand(command, args, options);
  results.push({ label, durationMs });
}

await run("i18n audit", "npm", ["run", "audit:i18n"]);
await run("frontend build", "npm", ["run", "build"]);
await run("rust fmt", "cargo", ["fmt", "--manifest-path", "src-tauri/Cargo.toml", "--check"]);
await run("rust check", "cargo", ["check", "--manifest-path", "src-tauri/Cargo.toml"]);
await run("rust unit tests", "cargo", ["test", "--manifest-path", "src-tauri/Cargo.toml", "--lib", "--", "--nocapture"]);
await run("integration stability", "node", ["tests/stability/integration.mjs"]);
await run("frontend/e2e stability", "node", ["tests/stability/e2e.mjs"]);
await run("soak stability", "node", ["tests/stability/soak.mjs"], {
  env: {
    ...process.env,
    SCRIBE_SOAK_ITERATIONS: process.env.SCRIBE_SOAK_ITERATIONS ?? "50"
  }
});

console.log("SCRIBE STABILITY PASS");
for (const result of results) {
  console.log(`${result.label}: ${result.durationMs}ms`);
}
console.log(`totalRuntimeMs: ${Date.now() - started}`);
