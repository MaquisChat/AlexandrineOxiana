// The arguments of `pnpm e2e` (run-e2e.mjs): which suite (--extension-only / --desktop-only, anywhere
// in argv, R116) and the rest, passed to that suite's Playwright. "--" separators are dropped.
const FLAGS = { "--extension-only": "extension", "--desktop-only": "desktop" };

export function parseE2eArgs(argv) {
  const flags = argv.filter((a) => a in FLAGS);
  if (new Set(flags).size > 1) throw new Error("Give one of --extension-only or --desktop-only, not both.");
  return { only: flags.length ? FLAGS[flags[0]] : undefined, args: argv.filter((a) => a !== "--" && !(a in FLAGS)) };
}
