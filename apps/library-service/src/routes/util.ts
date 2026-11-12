/** Small request helpers shared by the routes: typed reading of JSON bodies, params and query. */
import type { FastifyRequest } from "fastify";
import type { ServiceErrorCode } from "@ao/shared";
import { badRequest, notFound, type ErrorCode } from "../errors.js";
import type { RouteContext } from "../server.js";

export type Ctx = RouteContext;
export type Obj = Record<string, unknown>;

/**
 * `true` when A and B are the same type: `true satisfies Same<A, B>` compiles only then. Used where a
 * library type and its declaration in @ao/shared must stay one and the same (Task 47).
 */
export type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// The codes the service answers with are exactly those @ao/shared declares for the interface (Task 47).
true satisfies Same<ErrorCode, ServiceErrorCode>;

/** The JSON body as an object (an absent body is `{}`). */
export function bodyOf(req: FastifyRequest): Obj {
  const b = req.body;
  if (b === undefined || b === null) return {};
  if (typeof b !== "object" || Array.isArray(b)) throw badRequest("The request body must be a JSON object.");
  return b as Obj;
}

export function str(o: Obj, key: string, max = 4096): string {
  const v = o[key];
  if (typeof v !== "string" || v.length === 0) throw badRequest(`"${key}" is required (text).`);
  if (v.length > max) throw badRequest(`"${key}" is too long.`);
  return v;
}

export function optStr(o: Obj, key: string, max = 4096): string | undefined {
  return o[key] === undefined || o[key] === null ? undefined : str(o, key, max);
}

export function optBool(o: Obj, key: string): boolean | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw badRequest(`"${key}" must be true or false.`);
  return v;
}

export function strArray(o: Obj, key: string, opts: { max?: number; itemMax?: number; optional?: boolean } = {}): string[] {
  const v = o[key];
  if (v === undefined && opts.optional) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || x.length === 0 || x.length > (opts.itemMax ?? 4096))) {
    throw badRequest(`"${key}" must be a list of text values.`);
  }
  if (v.length > (opts.max ?? 1000)) throw badRequest(`"${key}" has too many values.`);
  return v as string[];
}

export function optObj(o: Obj, key: string): Obj | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) throw badRequest(`"${key}" must be an object.`);
  return v as Obj;
}

export function paramsOf(req: FastifyRequest): Record<string, string> {
  return (req.params ?? {}) as Record<string, string>;
}

export function queryOf(req: FastifyRequest): Record<string, string | undefined> {
  const q = (req.query ?? {}) as Record<string, unknown>;
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(q)) out[k] = typeof v === "string" ? v : Array.isArray(v) ? String(v[0]) : undefined;
  return out;
}

export function intParam(v: string | undefined, name: string, min: number, max: number, dflt: number): number {
  if (v === undefined || v === "") return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`"${name}" must be a whole number from ${min} to ${max}.`);
  return n;
}

/** The project of `:id`, which must exist in the open library. */
export function projectParam(ctx: Ctx, req: FastifyRequest): string {
  const id = paramsOf(req).id ?? "";
  const s = ctx.state.requireSession();
  if (!s.repo.listProjects().some((p) => p.id === id)) throw notFound("That project");
  return id;
}
