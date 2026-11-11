// Colours live only in src/theme/tokens.css (spec 8A.1: the UI never uses hard-coded colours).
// Everywhere else a colour comes from a token: var(--ink), var(--accent), ... (R100, R105 I2, R109).
// The .ts/.tsx side is checked by scripts/colour-scan.mjs.
import { NAMED_COLOURS, SYSTEM_COLOURS_AMBIGUOUS, SYSTEM_COLOURS_STRICT } from "./scripts/css-colour-names.mjs";

const words = (list) => list.map((w) => w.replace(/-/g, "\\-")).join("|");

/** Colour functions, any letter case. color-mix() is checked separately (tokens-only is allowed). */
const COLOUR_FUNCTIONS = /^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|device-cmyk|light-dark|color-contrast|contrast-color)$/i;

/** A system colour in any property (images, filters, -webkit-text-*, shadows, …). */
const SYSTEM_STRICT = new RegExp(`(^|[\\s,(])(${words(SYSTEM_COLOURS_STRICT)}|-moz-[a-z-]+)($|[\\s,)])`, "i");
/** A system colour that is also a word: as a whole colour value, or as an argument inside a function. */
const SYSTEM_AMBIGUOUS_IN_FUNCTION = new RegExp(`[(,]\\s*(${words(SYSTEM_COLOURS_AMBIGUOUS)})(\\s+[\\d.]+%)?\\s*[,)]`, "i");
const SYSTEM_AMBIGUOUS_ANYWHERE = new RegExp(`(^|[\\s,(])(${words(SYSTEM_COLOURS_AMBIGUOUS)})($|[\\s,)])`, "i");

/** Properties that take a colour (where an ambiguous system-colour word is a colour). */
const COLOUR_PROPERTIES =
  "/^(--.*|color|background(-color)?|border(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-color)?|outline(-color)?|fill|stroke|.*shadow|caret-color|accent-color|column-rule(-color)?|text-decoration(-color)?|text-emphasis(-color)?|scrollbar-color|stop-color|flood-color|lighting-color|-webkit-text-[a-z-]*|-webkit-tap-highlight-color)$/i";

/** data: URLs carrying a colour: an escaped "#" (%23), a named colour, or a base64 image. */
const DATA_URL_WITH_COLOUR = new RegExp(`url\\(\\s*['"]?\\s*data:[^)]*(%23|#|;base64,|(?<![\\w-])(${words(NAMED_COLOURS)})(?![\\w-]))`, "i");

/** color-mix() is allowed only when both colours are tokens: color-mix(in <space>, var(--a) [p%], var(--b) [p%]). */
const COLOR_MIX_NOT_TOKENS =
  /color-mix\((?!\s*in\s+[a-z0-9-]+(\s+(shorter|longer|increasing|decreasing)\s+hue)?\s*,\s*var\(--[\w-]+\)(\s+[\d.]+%)?\s*,\s*var\(--[\w-]+\)(\s+[\d.]+%)?\s*\))/i;

/** @type {import("stylelint").Config} */
export default {
  rules: {
    "color-no-hex": true,
    "color-named": "never",
    "function-disallowed-list": [COLOUR_FUNCTIONS],
    "declaration-property-value-disallowed-list": {
      [COLOUR_PROPERTIES]: [SYSTEM_AMBIGUOUS_ANYWHERE],
      "/.*/": [SYSTEM_STRICT, SYSTEM_AMBIGUOUS_IN_FUNCTION, DATA_URL_WITH_COLOUR, COLOR_MIX_NOT_TOKENS],
    },
  },
  overrides: [
    {
      files: ["**/src/theme/tokens.css"],
      rules: { "color-no-hex": null, "color-named": null, "function-disallowed-list": null, "declaration-property-value-disallowed-list": null },
    },
  ],
};
