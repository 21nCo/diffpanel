import { spawn } from "node:child_process";

export interface ProcessResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

export async function runProcess(
  command: string,
  args: string[],
  cwd: string,
  acceptedExitCodes: number[] = [0],
): Promise<ProcessResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      const result = {
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        exitCode: exitCode ?? -1,
      };
      if (!acceptedExitCodes.includes(result.exitCode)) {
        reject(new Error(
          `${command} ${args.join(" ")} failed (${result.exitCode}): ${result.stderr.toString("utf8").trim()}`,
        ));
        return;
      }
      resolve(result);
    });
  });
}

export async function gitBuffer(
  cwd: string,
  args: string[],
  acceptedExitCodes: number[] = [0],
): Promise<Buffer> {
  return (await runProcess("git", args, cwd, acceptedExitCodes)).stdout;
}

export async function gitText(
  cwd: string,
  args: string[],
  acceptedExitCodes: number[] = [0],
): Promise<string> {
  return (await gitBuffer(cwd, args, acceptedExitCodes)).toString("utf8").trim();
}

