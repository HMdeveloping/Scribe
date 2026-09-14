import { access } from "node:fs/promises";
import { spawnSync } from "node:child_process";

function run(label, command, args = []) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  console.log(`\n## ${label}`);
  console.log(`$ ${[command, ...args].join(" ")}`);
  console.log(output || "(no output)");
  if (result.status !== 0) {
    throw new Error(`${label} failed`);
  }
  return output;
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  run("macOS version", "sw_vers");
  const developerDir = run("xcode-select", "xcode-select", ["-p"]);
  run("xcodebuild", "xcodebuild", ["-version"]);
  const actoolPath = run("actool", "xcrun", ["--find", "actool"]);

  const iconComposerCandidates = [
    "/Applications/Icon Composer.app",
    "/Applications/Xcode.app/Contents/Applications/Icon Composer.app",
    `${developerDir}/Applications/Icon Composer.app`,
    `${developerDir.replace(/\/Contents\/Developer$/, "")}/Contents/Applications/Icon Composer.app`,
  ];

  console.log("\n## Icon Composer candidates");
  let foundIconComposer = false;
  for (const candidate of iconComposerCandidates) {
    const present = await exists(candidate);
    if (present) foundIconComposer = true;
    console.log(`${present ? "FOUND " : "MISSING"} ${candidate}`);
  }

  if (!foundIconComposer) {
    throw new Error("Icon Composer.app was not found in the expected locations");
  }

  console.log("\nModern macOS icon toolchain is available.");
  console.log(`Developer dir: ${developerDir}`);
  console.log(`actool: ${actoolPath}`);
}

main().catch((error) => {
  console.error(`\nERROR: ${error.message}`);
  process.exit(1);
});
