/**
 * The little of jsdom's own API the tests use directly (a document of their own in a test that runs
 * in Node, e.g. reader/geometry.test.ts); jsdom ships no types and none are added as a dependency.
 */
declare module "jsdom" {
  export class JSDOM {
    constructor(html?: string);
    readonly window: Window & typeof globalThis;
  }
}
