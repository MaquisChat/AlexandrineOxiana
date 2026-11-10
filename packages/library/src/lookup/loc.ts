/**
 * Library of Congress catalogue through its SRU gateway (MODS records), the ISBN fallback after
 * Open Library. Endpoint and its verification status: docs/adr/0011-metadata-sources.md
 * (documented base URL, not reachable from the build sandbox: unverified).
 */
import { toIsbn13, type Creator } from "@ao/core";
import { clean, decodeEntities, normalizeDate, parseName } from "../extract/names.js";
import type { LookupContext, LookupResult } from "./context.js";

export const LOC_SRU_BASE = "http://lx2.loc.gov:210/LCDB";

const ROLES: Record<string, Creator["role"]> = {
  author: "author",
  aut: "author",
  creator: "author",
  editor: "editor",
  edt: "editor",
  translator: "translator",
  trl: "translator",
  photographer: "photographer",
  interviewer: "interviewer",
  interviewee: "interviewee",
};

const text = (xml: string | undefined, tag: string): string | undefined => {
  if (!xml) return undefined;
  const m = new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, "u").exec(xml);
  return m ? clean(decodeEntities(m[1]!.replace(/<[^>]*>/gu, " "))) || undefined : undefined;
};
const all = (xml: string, tag: string): Array<{ attrs: string; inner: string }> =>
  [...xml.matchAll(new RegExp(`<(?:[\\w-]+:)?${tag}\\b([^>]*)>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, "gu"))].map((m) => ({
    attrs: m[1]!,
    inner: m[2]!,
  }));

/** Maps the first MODS record of an SRU searchRetrieve response. */
export function mapLocMods(xml: string, isbn13: string): LookupResult | null {
  const mods = /<(?:[\w-]+:)?mods\b[\s\S]*?<\/(?:[\w-]+:)?mods>/u.exec(xml)?.[0];
  if (!mods) return null;
  const titleInfo = all(mods, "titleInfo").find((t) => !/type=/u.test(t.attrs))?.inner ?? all(mods, "titleInfo")[0]?.inner;
  const main = text(titleInfo, "title");
  if (!main) return null;
  const nonSort = titleInfo ? /<(?:[\w-]+:)?nonSort\b[^>]*>([\s\S]*?)<\//u.exec(titleInfo)?.[1] : undefined;
  const sub = text(titleInfo, "subTitle");
  const title = clean(`${nonSort ? decodeEntities(nonSort) : ""}${main}`) + (sub ? `: ${sub}` : "");

  const creators: Creator[] = [];
  for (const n of all(mods, "name")) {
    if (!/type="personal"/u.test(n.attrs)) continue;
    const part = all(n.inner, "namePart").find((p) => !/type=/u.test(p.attrs));
    const roleText = (text(n.inner, "roleTerm") ?? "author").toLowerCase().replace(/[^a-z]/gu, "");
    const c = part ? parseName(decodeEntities(part.inner), ROLES[roleText] ?? "contributor") : undefined;
    if (c) creators.push(c);
  }

  const isbns = all(mods, "identifier")
    .filter((i) => /type="isbn"/u.test(i.attrs))
    .map((i) => toIsbn13(clean(i.inner).split(/\s/u)[0] ?? ""))
    .filter((i): i is string => !!i);
  const issued = normalizeDate(text(mods, "dateIssued"));
  const publisher = text(mods, "publisher");
  return {
    title,
    creators,
    ...(issued ? { issued } : {}),
    ...(publisher ? { publisher } : {}),
    type: "book",
    identifiers: { isbn: [...new Set([isbn13, ...isbns])] },
    provider: "loc",
  };
}

export async function locIsbn(isbn13: string, ctx: LookupContext): Promise<LookupResult | null> {
  const query = `version=1.1&operation=searchRetrieve&query=${encodeURIComponent(`bath.isbn=${isbn13}`)}&maximumRecords=1&recordSchema=mods`;
  const xml = await ctx.http.getText(`${LOC_SRU_BASE}?${query}`, { cacheKey: `loc:isbn:${isbn13}`, ttlDays: 30, sensitive: ctx.sensitive });
  return xml ? mapLocMods(xml, isbn13) : null;
}
