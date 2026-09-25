import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const appDirectory = path.resolve(scriptDirectory, "..");
const stagingDirectory = await mkdtemp(path.join(tmpdir(), "diffpanel-vsix-"));

try {
  const manifest = JSON.parse(await readFile(path.join(appDirectory, "package.json"), "utf8"));
  manifest.name = "diffpanel";
  delete manifest.private;

  await writeFile(path.join(stagingDirectory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const entry of ["README.md", "CHANGELOG.md", "dist", "media"]) {
    await cp(path.join(appDirectory, entry), path.join(stagingDirectory, entry), { recursive: true });
  }

  const binary = path.join(appDirectory, "node_modules", ".bin", process.platform === "win32" ? "vsce.cmd" : "vsce");
  const output = path.join(appDirectory, `diffpanel-${manifest.version}.vsix`);
  await run(binary, ["package", "--no-dependencies", "--allow-missing-repository", "--out", output], stagingDirectory);
  process.stdout.write(`${output}\n`);
} finally {
  await rm(stagingDirectory, { recursive: true, force: true });
}

async function run(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code ?? -1}`)));
  });
}
