import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
const appdmg = require("appdmg");

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const bundleRoot = path.join(repoRoot, "src-tauri", "target", "aarch64-apple-darwin", "release", "bundle");
const dmgDir = path.join(bundleRoot, "dmg");
const macosDir = path.join(bundleRoot, "macos");

async function existingFiles(dir, predicate) {
  const entries = await readdir(dir);
  return entries
    .filter(predicate)
    .map((entry) => path.join(dir, entry));
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

function buildDmg(target, specification) {
  return new Promise((resolve, reject) => {
    const emitter = appdmg({
      target,
      basepath: repoRoot,
      specification,
    });

    emitter.on("progress", (info) => {
      if (info.type === "step-begin") {
        console.log(`[appdmg] ${info.current}/${info.total} ${info.title}`);
      }
      if (info.type === "step-end" && info.status === "fail") {
        console.log(`[appdmg] ${info.current}/${info.total} failed`);
      }
    });
    emitter.on("finish", resolve);
    emitter.on("error", reject);
  });
}

const appTarCandidates = await existingFiles(macosDir, (entry) => entry.endsWith(".app.tar.gz"));
if (appTarCandidates.length !== 1) {
  throw new Error(`Expected exactly one signed app tarball in ${macosDir}, found ${appTarCandidates.length}`);
}

await mkdir(dmgDir, { recursive: true });
const dmgCandidates = await existingFiles(dmgDir, (entry) => entry.endsWith(".dmg"));
if (dmgCandidates.length > 1) {
  throw new Error(`Expected at most one existing release DMG in ${dmgDir}, found ${dmgCandidates.length}`);
}

const tauriConfig = JSON.parse(await readFile(path.join(repoRoot, "src-tauri", "tauri.conf.json"), "utf8"));
const appVersion = tauriConfig.version;
const finalDmgPath = dmgCandidates[0] ?? path.join(dmgDir, `Scribe_${appVersion}_aarch64.dmg`);

const tempDir = await mkdtemp(path.join(tmpdir(), "scribe-release-dmg-"));
const appTarPath = appTarCandidates[0];
const appPath = path.join(tempDir, "Scribe.app");

try {
  await run("tar", ["-xzf", appTarPath, "-C", tempDir]);
  const appStats = await stat(appPath);
  if (!appStats.isDirectory()) {
    throw new Error(`Extracted app is not a directory: ${appPath}`);
  }

  await rm(finalDmgPath, { force: true });
  await buildDmg(finalDmgPath, {
    title: "Scribe",
    icon: path.join(repoRoot, "src-tauri", "icons", "icon.icns"),
    background: path.join(repoRoot, "src-tauri", "dmg-background.png"),
    "icon-size": 128,
    window: {
      position: { x: 10, y: 60 },
      size: { width: 660, height: 400 },
    },
    format: "UDZO",
    filesystem: "HFS+",
    contents: [
      { x: 185, y: 200, type: "file", path: appPath, name: "Scribe.app" },
      { x: 475, y: 200, type: "link", path: "/Applications" },
    ],
  });

  const finalStats = await stat(finalDmgPath);
  if (!finalStats.isFile() || finalStats.size <= 0) {
    throw new Error(`Final DMG was not created correctly: ${finalDmgPath}`);
  }
  console.log(`Created deterministic release DMG: ${finalDmgPath}`);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
