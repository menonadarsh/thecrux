import { config } from "./config.js";
import { createBackup, restoreBackup } from "./backup.js";

const USAGE = `thecrux — admin CLI

Usage:
  crux backup [--out <dir>]      Write a .tar.gz of the data dir (default: cwd)
  crux restore <archive> [--force]
                                 Restore a backup into the data dir
                                 (--force overwrites a non-empty data dir)

The data dir is ${config.dataDir} (override with CRUX_DATA_DIR).
`;

/** Pull a `--flag value` out of args, returning the value (or undefined). */
function takeOption(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const value = args[i + 1];
  args.splice(i, value ? 2 : 1);
  return value;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift();

  switch (command) {
    case "backup": {
      const outDir = takeOption(args, "--out") ?? args[0];
      const file = await createBackup({ outDir });
      console.log(`Backup written: ${file}`);
      break;
    }
    case "restore": {
      const force = args.includes("--force");
      const archive = args.find((a) => !a.startsWith("--"));
      if (!archive) {
        console.error("restore: missing <archive> path.\n");
        console.error(USAGE);
        process.exit(1);
      }
      await restoreBackup(archive, { force });
      console.log(`Restored ${archive} into ${config.dataDir}`);
      break;
    }
    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(USAGE);
      break;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.error(USAGE);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
