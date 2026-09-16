import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { test } from "node:test";

/**
 * #410 finding 4 — a holistic-audit review found the studio's DOM tests asserted only that
 * `index.html` declares the right element ids/roles/labels (see `../index.test.mjs`), but no test
 * ever loaded `web/styles.css` itself. That meant a change that silently broke the #313
 * side-by-side grid layout — e.g. deleting `main { display: grid; }`, dropping a `grid-area`
 * declaration, or removing the `@media (min-width: 48rem)` two-column breakpoint — would pass the
 * full test suite untouched: a textbook false-green. This file is the first (and, deliberately,
 * only) place `web/styles.css` is read and asserted on, closing that gap by proving the real
 * layout contract described in the file's own `#313` doc comment: every pane the markup declares
 * has a `grid-area`, the mobile (default) layout stacks all panes in a single column, and the
 * `48rem` breakpoint switches to the two-column grid with the turtle canvas spanning both rows
 * beside the editor/controls column. As with `../index.test.mjs`, this is a textual/source
 * assertion (no CSS engine or browser is available in this monorepo's `node:test` runner), which
 * is enough to catch the exact class of regression the audit found — a real browser-based
 * (e.g. Playwright) visual test would still be the strongest possible proof.
 */

const webDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.dirname(webDir);
const stylesCss = readFileSync(path.join(webDir, "styles.css"), "utf8");
const indexHtml = readFileSync(path.join(packageDir, "index.html"), "utf8");

/** The `.pane-*` classes the #313 grid layout is built from, and the `grid-area` name each one
 * must occupy — mirrors the `main`/`main:has(...)` rules in `styles.css` exactly. */
const PANE_GRID_AREAS = {
  "pane-lesson": "lesson",
  "pane-editor": "editor",
  "pane-controls": "controls",
  "pane-turtle": "turtle",
  "pane-output": "output",
  "pane-diagnostics": "diagnostics",
  "pane-tutor": "tutor",
};

test("web/styles.css declares main as a CSS grid container", () => {
  assert.match(
    stylesCss,
    /main\s*\{[^}]*display:\s*grid;/,
    "the #313 side-by-side layout depends on `main` being a grid container",
  );
});

test("web/styles.css assigns every pane class its own grid-area, matching index.html's markup (#410)", () => {
  for (const [paneClass, gridArea] of Object.entries(PANE_GRID_AREAS)) {
    const ruleMatch = stylesCss.match(
      new RegExp(`\\.${paneClass}\\s*\\{([^}]*)\\}`),
    );
    assert.ok(ruleMatch, `expected a .${paneClass} rule in styles.css`);
    assert.match(
      ruleMatch[1],
      new RegExp(`grid-area:\\s*${gridArea};`),
      `.${paneClass} must occupy the "${gridArea}" grid-area`,
    );
    assert.match(
      indexHtml,
      new RegExp(`class="${paneClass}"`),
      `expected index.html to have an element with class="${paneClass}"`,
    );
  }
});

test("web/styles.css keeps the narrow (default) layout single-column with every visible pane stacked in DOM/focus order (#410)", () => {
  const mainRuleMatch = stylesCss.match(/main\s*\{([^}]*)\}/);
  assert.ok(mainRuleMatch, "expected a `main { ... }` rule in styles.css");
  assert.match(
    mainRuleMatch[1],
    /grid-template-columns:\s*1fr;/,
    "the default/mobile layout must be a single column",
  );
  const areasMatch = mainRuleMatch[1].match(
    /grid-template-areas:\s*((?:"[^"]*"\s*)+)/,
  );
  assert.ok(
    areasMatch,
    "expected `main` to declare grid-template-areas for the default layout",
  );
  const rows = [...areasMatch[1].matchAll(/"([^"]*)"/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(
    rows,
    ["editor", "controls", "turtle", "output", "diagnostics"],
    "the default single-column layout must stack editor, controls, turtle, output, then diagnostics",
  );
});

test("web/styles.css switches to an editor/turtle grid with a draggable divider at the 48rem breakpoint", () => {
  const mediaStart = stylesCss.indexOf("@media (min-width: 48rem)");
  assert.ok(
    mediaStart >= 0,
    "expected a `@media (min-width: 48rem)` breakpoint in styles.css",
  );
  // The 48rem breakpoint's `main { ... }` rule is the first one after the media query opens.
  const mediaBody = stylesCss.slice(mediaStart);

  const mainRuleMatch = mediaBody.match(/main\s*\{([^}]*)\}/);
  assert.ok(
    mainRuleMatch,
    "expected the 48rem breakpoint to redeclare `main`'s grid",
  );
  assert.match(
    mainRuleMatch[1],
    /grid-template-columns:\s*minmax\(0,\s*var\(--editor-pane-share\)\)\s+0\.7rem\s+minmax\(20rem,\s*var\(--turtle-pane-share\)\);/,
    "the 48rem two-column grid must floor the editor track at 0 so long, " +
      "non-wrapping lines scroll inside the editor instead of stealing width, and give the " +
      "turtle track a NON-ZERO rem-based minimum floor (not `0rem`/`0fr`) so the drawing pane " +
      "keeps a usable minimum size (#472)",
  );
  const areasMatch = mainRuleMatch[1].match(
    /grid-template-areas:\s*((?:"[^"]*"\s*)+)/,
  );
  assert.ok(
    areasMatch,
    "expected the 48rem `main` rule to redeclare grid-template-areas",
  );
  const rows = [...areasMatch[1].matchAll(/"([^"]*)"/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(
    rows,
    [
      "editor editor-turtle-resizer turtle",
      "controls editor-turtle-resizer turtle",
      "output output output",
      "diagnostics diagnostics diagnostics",
    ],
    "the layout must place a draggable divider between editor/controls and the turtle canvas",
  );
});

test("web/styles.css floors every grid item's min-width at 0 so a long editor line can't inflate its column (#472)", () => {
  const sectionRuleMatch = stylesCss.match(/main section\s*\{([^}]*)\}/);
  assert.ok(
    sectionRuleMatch,
    "expected a `main section { ... }` rule in styles.css",
  );
  assert.match(
    sectionRuleMatch[1],
    /min-width:\s*0;/,
    "grid items must set `min-width: 0` — a grid item's default `auto` (min-content) minimum " +
      "would otherwise let a long, non-wrapping CodeMirror line stretch the editor track and " +
      "squeeze the turtle track (#472)",
  );
});

test("web/styles.css makes the turtle canvas grow to its column width and stay square with a usable minimum-size floor (#472)", () => {
  const canvasRuleMatch = stylesCss.match(/#turtle-canvas\s*\{([^}]*)\}/);
  assert.ok(
    canvasRuleMatch,
    "expected a `#turtle-canvas { ... }` rule in styles.css",
  );
  const canvasRule = canvasRuleMatch[1];
  assert.match(
    canvasRule,
    /width:\s*100%;/,
    "the canvas must grow to fill the width available to its column",
  );
  assert.match(
    canvasRule,
    /aspect-ratio:\s*1\s*\/\s*1;/,
    "the canvas must keep a 1:1 aspect ratio as it scales, matching its square backing store",
  );
  assert.match(
    canvasRule,
    /min-width:\s*min\(\s*100%\s*,\s*[1-9][\d.]*rem\s*\);/,
    "the canvas needs a usable minimum size (never a thumbnail), capped at 100% of its pane so a " +
      "very narrow column still scales it down to fit instead of overflowing (#472)",
  );
});

test("web/styles.css keeps lesson mode overflow-safe at the 48rem breakpoint and only uses three columns on wide screens", () => {
  const mediaStart = stylesCss.indexOf("@media (min-width: 48rem)");
  assert.ok(
    mediaStart >= 0,
    "expected a `@media (min-width: 48rem)` breakpoint in styles.css",
  );
  const wideMediaStart = stylesCss.indexOf("@media (min-width: 72rem)");
  assert.ok(
    wideMediaStart > mediaStart,
    "expected a later 72rem breakpoint for the three-column lesson layout",
  );
  const tabletMediaBody = stylesCss.slice(mediaStart, wideMediaStart);
  const lessonSelectors = [
    "main:has(.pane-lesson:not([hidden]))",
    "main:has(.pane-lesson:not([hidden])):has(.pane-tutor:not([hidden]))",
  ];
  for (const selector of lessonSelectors) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const tabletRuleMatch = tabletMediaBody.match(
      new RegExp(`${escaped}\\s*\\{([^}]*)\\}`),
    );
    assert.ok(tabletRuleMatch);
    assert.match(
      tabletRuleMatch[1],
      /grid-template-columns:\s*minmax\(0,\s*var\(--editor-pane-share\)\)\s+0\.7rem\s+minmax\(20rem,\s*var\(--turtle-pane-share\)\);/,
      `expected \`${selector}\` to remain two-column at 48rem`,
    );

    const wideMediaBody = stylesCss.slice(wideMediaStart);
    const wideRuleMatch = wideMediaBody.match(
      new RegExp(`${escaped}\\s*\\{([^}]*)\\}`),
    );
    assert.ok(wideRuleMatch);
    const columnsMatch = wideRuleMatch[1].match(
      /grid-template-columns:\s*([^;]*);/,
    );
    assert.ok(
      columnsMatch,
      `expected wide \`${selector}\` to declare grid-template-columns`,
    );
    assert.match(
      columnsMatch[1],
      /minmax\(20rem,\s*var\(--turtle-pane-share\)\)\s*$/,
      `the wide turtle track in \`${selector}\` must keep a non-zero minimum`,
    );
  }
});

test("web/styles.css wraps lesson source and toolbar controls without creating page-level horizontal scrolling", () => {
  assert.match(stylesCss, /body\s*\{[^}]*overflow-x:\s*clip;/s);
  assert.match(
    stylesCss,
    /\.worked-example-source\s*\{[^}]*white-space:\s*pre-wrap;[^}]*overflow-wrap:\s*anywhere;/s,
  );
  assert.match(stylesCss, /\.pane-controls\s*\{[^}]*flex-wrap:\s*wrap;/s);
  assert.match(
    stylesCss,
    /\.cm-editor\s*\{[^}]*min-height:\s*clamp\(18rem,\s*52vh,\s*38rem\);/s,
  );
});

test("web/styles.css exposes persistent custom-property shares for all three resizable panes", () => {
  assert.match(stylesCss, /--lesson-pane-share:\s*20fr;/);
  assert.match(stylesCss, /--editor-pane-share:\s*48fr;/);
  assert.match(stylesCss, /--turtle-pane-share:\s*42fr;/);
  assert.match(stylesCss, /minmax\(12rem,\s*var\(--lesson-pane-share\)\)/);
});

test("web/styles.css exposes hoverable mouse-drag dividers between resizable panes", () => {
  assert.match(
    stylesCss,
    /\.pane-resizer\s*\{[^}]*cursor:\s*col-resize;[^}]*touch-action:\s*none;/s,
  );
  assert.match(
    stylesCss,
    /\.pane-resizer::before\s*\{[^}]*radial-gradient[^}]*#edf4ef;/s,
  );
  assert.match(
    stylesCss,
    /\.pane-resizer:hover::before,[^}]*border-color:\s*var\(--ol-green\);/s,
  );
  assert.match(
    stylesCss,
    /\.pane-resizer-editor-turtle\s*\{[^}]*grid-area:\s*editor-turtle-resizer;/s,
  );
  assert.match(
    stylesCss,
    /\.pane-resizer-lesson-editor\s*\{[^}]*grid-area:\s*lesson-editor-resizer;/s,
  );
});

test("web/styles.css keeps the turtle canvas 500x500 backing resolution unchanged — Slice B (#474), not this slice (#472)", () => {
  const canvasTagMatch = indexHtml.match(
    /<canvas\b[^>]*\bid="turtle-canvas"[^>]*>/,
  );
  assert.ok(
    canvasTagMatch,
    'expected a `<canvas id="turtle-canvas" ...>` opening tag in index.html',
  );
  const canvasTag = canvasTagMatch[0];
  assert.match(
    canvasTag,
    /\bwidth="500"/,
    "the canvas backing width attribute must stay 500 (drawing resolution is Slice B #474)",
  );
  assert.match(
    canvasTag,
    /\bheight="500"/,
    "the canvas backing height attribute must stay 500 (drawing resolution is Slice B #474)",
  );
});
