// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import pc from "picocolors";
import { doctorCommand } from "./commands/doctor.js";
import { typesCommand, DEFAULT_OUT } from "./commands/types.js";
import { CliError } from "./errors.js";
import { boolFlag, parseArgs } from "./utils/args.js";
import { log } from "./utils/log.js";
import { readVersion } from "./version.js";

export { readVersion };

const HELP = `
${pc.bold(pc.cyan("heopress"))} ${pc.dim("— the HeoPress CLI")}

${pc.bold("Usage")}
  heopress <command> [options]

${pc.bold("Commands")}
  types           Generate TypeScript types from a live schema
  doctor          Check configuration and connectivity

${pc.bold("Connection")}
  Resolved with precedence flag > environment > ${pc.cyan("heopress.config.json")}.
  The token is never read from the config file.

  --url <url>     CMS base URL          ${pc.dim("(HEOPRESS_URL)")}
  --site <id>     Site / tenant id      ${pc.dim("(HEOPRESS_SITE_ID)")}
  --token <tok>   Bearer token          ${pc.dim("(HEOPRESS_TOKEN)")}

${pc.bold("heopress types")}
  --out <path>    Output file           ${pc.dim(`(default: ${DEFAULT_OUT})`)}
  --include <a,b> Only these collections
  --exclude <a,b> Skip these collections
  --no-branded    Emit plain string ids instead of branded ones
  --import-from <pkg>  Module the generated file imports from ${pc.dim('(default: heopress)')}
  --check         Fail if the file is missing or stale ${pc.dim("(use in CI)")}
  --stdout        Print to stdout instead of writing a file

${pc.bold("Examples")}
  ${pc.dim("$")} heopress types --out src/heopress-types.d.ts
  ${pc.dim("$")} heopress types --check
  ${pc.dim("$")} heopress doctor

  Docs: ${pc.cyan("https://docs.heopress.example")}
`;

export async function run(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const command = args._[0];

  if (boolFlag(args, "version") && !command) {
    log.plain(readVersion());
    return 0;
  }

  if (!command || boolFlag(args, "help")) {
    // `heopress --help` is a successful request for help; `heopress` with no
    // command at all is a usage error, so the exit code differs.
    log.plain(HELP);
    return boolFlag(args, "help") ? 0 : 1;
  }

  switch (command) {
    case "types":
      return typesCommand(args);
    case "doctor":
      return doctorCommand(args);
    case "help":
      log.plain(HELP);
      return 0;
    case "version":
      log.plain(readVersion());
      return 0;
    default:
      throw new CliError(
        `Unknown command: ${command}`,
        "Run `heopress --help` to see the available commands.",
      );
  }
}
