// Types of netns.mjs (the desktop end-to-end command, run by node directly) for its test.
export const SWITCH: string;
export const INSIDE: string;
export const FAILED: string;
export const NAMESPACE_TOOLS: string[];
export const OUTSIDE: { host: string; port: number };
export const LOOPBACK_UP_PY: string;
export const SECOND_LOOPBACK: string;
export type Plan = { kind: "direct" } | { kind: "inside" } | { kind: "reexec" } | { kind: "fail"; reason: string };
export function plan(p: { env: Record<string, string | undefined>; platform: string; uid: number | undefined; has: (tool: string) => boolean }): Plan;
export function interfaces(netDev: string): string[];
export function checkNamespace(): Promise<string>;
