// Colours live only in src/theme/tokens.css (spec 8A.1: the UI never uses hard-coded colours).
// Everywhere else a colour comes from a token: var(--ink), var(--accent), ... (R100, R105 I2).
// The .ts/.tsx side is checked by scripts/colour-scan.mjs.

/** Colour functions, any letter case. */
const COLOUR_FUNCTIONS = /^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|device-cmyk|color-mix|light-dark|color-contrast|contrast-color)$/i;

/** CSS system colours (current and deprecated) and vendor ones, any letter case. */
const SYSTEM_COLOURS =
  /(^|[\s,(])(-webkit-focus-ring-color|-webkit-link|-moz-[a-z-]+|accentcolor|accentcolortext|activeborder|activecaption|activetext|appworkspace|background|buttonborder|buttonface|buttonhighlight|buttonshadow|buttontext|canvas|canvastext|captiontext|field|fieldtext|graytext|highlight|highlighttext|inactiveborder|inactivecaption|inactivecaptiontext|infobackground|infotext|linktext|mark|marktext|menu|menutext|scrollbar|selecteditem|selecteditemtext|threeddarkshadow|threedface|threedhighlight|threedlightshadow|threedshadow|visitedtext|window|windowframe|windowtext)($|[\s,)])/i;

/** Properties that take a colour (where a system-colour keyword would be a hard-coded colour). */
const COLOUR_PROPERTIES = "/^(--.*|color|background(-color)?|border(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-color)?|outline(-color)?|fill|stroke|.*shadow|caret-color|accent-color|column-rule(-color)?|text-decoration(-color)?|text-emphasis(-color)?|scrollbar-color|stop-color|flood-color|lighting-color)$/i";

/** A data: URL with an escaped "#" (%23) is almost always an inline SVG with a colour in it. */
const DATA_URL_WITH_HASH = /url\(\s*['"]?\s*data:[^)]*(%23|#)/i;

/** @type {import("stylelint").Config} */
export default {
  rules: {
    "color-no-hex": true,
    "color-named": "never",
    "function-disallowed-list": [COLOUR_FUNCTIONS],
    "declaration-property-value-disallowed-list": {
      [COLOUR_PROPERTIES]: [SYSTEM_COLOURS],
      "/.*/": [DATA_URL_WITH_HASH],
    },
  },
  overrides: [
    {
      files: ["**/src/theme/tokens.css"],
      rules: { "color-no-hex": null, "color-named": null, "function-disallowed-list": null, "declaration-property-value-disallowed-list": null },
    },
  ],
};
