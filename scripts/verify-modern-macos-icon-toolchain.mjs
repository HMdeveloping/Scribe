import { access } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const iconSource = path.join(repoRoot, "src-tauri", "icon-composer", "Scribe.icon");

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

function requireXcode27(xcodeVersion) {
  const match = xcodeVersion.match(/^Xcode\s+(\d+)(?:\.|\s|$)/m);
  if (!match) {
    throw new Error(`Unable to parse Xcode version:\n${xcodeVersion}`);
  }
  if (match[1] !== "27") {
    throw new Error(`Expected Xcode 27.x for frozen Icon Composer source, got:\n${xcodeVersion}`);
  }
}

async function main() {
  run("macOS version", "sw_vers");
  const developerDir = run("xcode-select", "xcode-select", ["-p"]);
  const xcodeVersion = run("xcodebuild", "xcodebuild", ["-version"]);
  requireXcode27(xcodeVersion);
  const actoolPath = run("actool", "xcrun", ["--find", "actool"]);
  run("macOS SDK", "xcrun", ["--sdk", "macosx", "--show-sdk-version"]);

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

  if (!(await exists(iconSource))) {
    throw new Error(`Frozen Icon Composer source was not found: ${iconSource}`);
  }
  console.log(`FOUND ${iconSource}`);

  console.log("\nModern macOS icon toolchain is available.");
  console.log(`Developer dir: ${developerDir}`);
  console.log(`actool: ${actoolPath}`);
}

main().catch((error) => {
  console.error(`\nERROR: ${error.message}`);
  process.exit(1);
});
