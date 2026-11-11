// The arguments of `pnpm e2e` (run-e2e.mjs): which suite (--extension-only / --app-only /
// --desktop-only, anywhere in argv, R116) and the rest, passed to that suite's Playwright. "--"
// separators are dropped.
const FLAGS = { "--extension-only": "extension", "--app-only": "app", "--desktop-only": "desktop" };

export function parseE2eArgs(argv) {
  const flags = argv.filter((a) => a in FLAGS);
  if (new Set(flags).size > 1) throw new Error("Give one of --extension-only, --app-only or --desktop-only, not more.");
  return { only: flags.length ? FLAGS[flags[0]] : undefined, args: argv.filter((a) => a !== "--" && !(a in FLAGS)) };
}

/**
 * Extra arguments with no suite flag would reach more than one suite (a spec path of one suite is
 * not a path in another), so the runner refuses them. With no extra arguments every suite runs.
 */
/**
 * The Playwright JSON that stands in for a suite that ran but wrote no results (it crashed before
 * its reporter ran): `pnpm report` shows it as a failure instead of leaving the suite out.
 */
export function noResults(suite, status) {
  return { suites: [], errors: [{ message: `the ${suite} suite wrote no results (exit status ${status})` }] };
}

export function needsSuiteFlag({ only, args }) {
  return !only && args.length > 0;
}
