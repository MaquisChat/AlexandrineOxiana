// Colours live only in src/theme/tokens.css (spec 8A.1: the UI never uses hard-coded colours).
// Everywhere else a colour comes from a token: var(--ink), var(--accent), ...
const NO_COLOUR_FUNCTIONS = ["rgb", "rgba", "hsl", "hsla", "hwb", "lab", "lch", "oklab", "oklch", "color"];

/** @type {import("stylelint").Config} */
export default {
  rules: {
    "color-no-hex": true,
    "color-named": "never",
    "function-disallowed-list": NO_COLOUR_FUNCTIONS,
  },
  overrides: [
    {
      files: ["**/src/theme/tokens.css"],
      rules: { "color-no-hex": null, "color-named": null, "function-disallowed-list": null },
    },
  ],
};
