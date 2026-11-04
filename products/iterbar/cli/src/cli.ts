#!/usr/bin/env node
import { runDev } from "./commands/dev.js";

const USAGE = `Usage: iterbar <command> [options]

Commands:
  dev   Start the local Iterbar daemon for a project

Run "iterbar <command> --help" for a command's options.
`;

async function main(args: readonly string[]): Promise<number> {
  const [command, ...rest] = args;
  switch (command) {
    case "dev":
      return runDev(rest);
    case "-h":
    case "--help":
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(command === undefined ? USAGE : `iterbar: unknown command ${JSON.stringify(command)}\n\n${USAGE}`);
      return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
