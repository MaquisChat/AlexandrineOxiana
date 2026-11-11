export interface ColourFinding {
  file: string;
  line: number;
  rule: "colour-literal" | "colour-style" | "colour-svg" | "colour-sheet" | "colour-canvas";
  text: string;
}
export function scanSource(src: string, file: string): ColourFinding[];
export function scanFiles(pkgDir: string | URL): ColourFinding[];
