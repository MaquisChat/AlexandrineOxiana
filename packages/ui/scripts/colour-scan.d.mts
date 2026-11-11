export interface ColourFinding {
  file: string;
  line: number;
  rule: "colour-literal" | "colour-style";
  text: string;
}
export function scanSource(src: string, file: string): ColourFinding[];
export function scanFiles(pkgDir: string | URL): ColourFinding[];
