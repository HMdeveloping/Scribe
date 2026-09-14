import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const defaultIconSource = path.join(repoRoot, "src-tauri", "icon-composer", "Scribe.icon");
const defaultOutputDir = path.join(repoRoot, "src-tauri", "target", "modern-macos-icon");
const appIconName = "Scribe";

function argValue(name, fallback) {
  const prefix = `${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
      }
    });
  });
}

async function requirePath(label, filePath) {
  try {
    await stat(filePath);
  } catch {
    throw new Error(`${label} not found: ${filePath}`);
  }
}

async function main() {
  const iconSource = path.resolve(argValue("--icon", defaultIconSource));
  const outputDir = path.resolve(argValue("--out", defaultOutputDir));
  const minimumDeploymentTarget = argValue("--minimum-deployment-target", "13.0");

  await run("xcrun", ["--find", "actool"]);
  await requirePath("Icon Composer source", iconSource);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  await run("xcrun", [
    "actool",
    iconSource,
    "--compile",
    outputDir,
    "--app-icon",
    appIconName,
    "--output-format",
    "xml1",
    "--notices",
    "--warnings",
    "--errors",
    "--include-all-app-icons",
    "--enable-on-demand-resources",
    "NO",
    "--development-region",
    "en",
    "--target-device",
    "mac",
    "--platform",
    "macosx",
    "--minimum-deployment-target",
    minimumDeploymentTarget,
    "--output-partial-info-plist",
    path.join(outputDir, "assetcatalog-generated-info.plist"),
  ]);

  await requirePath("Compiled Assets.car", path.join(outputDir, "Assets.car"));
  await requirePath("Generated legacy ICNS", path.join(outputDir, `${appIconName}.icns`));

  console.log(`Compiled modern macOS icon assets: ${outputDir}`);
  console.log(`Assets.car: ${path.join(outputDir, "Assets.car")}`);
  console.log(`Legacy ICNS: ${path.join(outputDir, `${appIconName}.icns`)}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
