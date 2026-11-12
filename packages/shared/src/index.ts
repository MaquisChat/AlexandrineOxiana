/**
 * Small constants and rules shared by the library service and the UI (R105). No Node or DOM APIs
 * here: both a Node service and a browser bundle import this package.
 */
export { CREDENTIAL_QUERY_KEYS, isCredentialQueryKey } from "./credentials.js";
export * from "./api/index.js";
export { BUNDLED_FONT_FAMILIES, CSS_WIDE_KEYWORDS, GENERIC_FAMILIES, GENERIC_FONT_KEYWORDS, inferGenericFamily, isGenericFamily, isUsableFontFamily, reservedFontName, splitFontFamilies, type GenericFamily, type ReservedFontName } from "./fonts.js";
