#!/usr/bin/env node
import { runCli, CliUserError } from "./lib/cli-runtime.js";

runCli(process.argv.slice(2)).catch((error) => {
  const userFacing =
    error instanceof CliUserError ||
    (error instanceof Error && (error as { userFacing?: boolean }).userFacing === true);
  const message = error instanceof Error
    ? (userFacing ? error.message : error.stack ?? error.message)
    : String(error);
  process.stderr.write(`vidlens-mcp failed: ${message}\n`);
  process.exitCode = 1;
});
