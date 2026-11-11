/**
 * Small constants and rules shared by the library service and the UI (R105). No Node or DOM APIs
 * here: both a Node service and a browser bundle import this package.
 */
export { CREDENTIAL_QUERY_KEYS, isCredentialQueryKey } from "./credentials.js";
export * from "./api/index.js";
export { GENERIC_FAMILIES, inferGenericFamily, isGenericFamily, isUsableFontFamily, splitFontFamilies, type GenericFamily } from "./fonts.js";
