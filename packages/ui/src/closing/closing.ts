// The closing window's page (closing.html; FR-297, R470 c): the theme's tokens, fonts and base
// styles, its own small layout, and the system's light or dark. Nothing else.
import "../theme/tokens.css";
import "../theme/fonts.css";
import "../theme/base.css";
import "./closing.css";
import { followSystemTheme } from "./closingPage";

followSystemTheme(window);
