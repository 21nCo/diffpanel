#!/usr/bin/env node
import { runDev } from "./commands/dev.js";
import { runMcp } from "./mcp/command.js";

const USAGE = `Usage: iterbar <command> [options]

Commands:
  dev   Start the local Iterbar daemon for a project
  mcp   Run the MCP server that lets a coding agent read and answer feedback

Run "iterbar <command> --help" for a command's options.
`;

async function main(args: readonly string[]): Promise<number> {
  const [command, ...rest] = args;
  switch (command) {
    case "dev":
      return runDev(rest);
    case "mcp":
      return runMcp(rest);
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
