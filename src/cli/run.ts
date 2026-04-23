// Placeholder CLI dispatcher — real subcommands land with the daemon slice.
export async function runCli(args: string[]): Promise<void> {
  const [cmd, ...rest] = args;
  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    case "version":
    case "--version":
    case "-v":
      console.log("olle 0.0.0");
      return;
    default:
      console.error(`Unknown command: ${cmd}. Extra: ${rest.join(" ")}`);
      printHelp();
      process.exit(2);
  }
}

function printHelp(): void {
  console.log(
    [
      "olle — a world agents love to live in",
      "",
      "Usage: olle <command> [args]",
      "",
      "Commands (v0 scaffold — more arrive with later slices):",
      "  run              start foreground daemon",
      "  tail             stream events from a running daemon",
      "  inbox            list/respond to decisions",
      "  chat [agent]     REPL connected to an agent",
      "  version          show version",
      "  help             show this help",
    ].join("\n"),
  );
}
