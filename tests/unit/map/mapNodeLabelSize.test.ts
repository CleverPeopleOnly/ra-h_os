/**
 * MAP LEGIBILITY, half B — the size of the text inside a map node.
 *
 * WHY 10px. Against a real graph the node labels are larger than the job
 * needs: at 11px, on nodes whose own min-width is 56px and max-width 168px,
 * the label dominates and crowds out the edges around it, which is the same
 * legibility complaint the edge-visibility half fixes from the other side.
 * Dropping the base rule to 10px gives the label back its proportion without
 * taking it below the size the rest of the app already uses for small
 * secondary text.
 *
 * The pinned contract for src/components/panes/map/map-styles.css: the BASE
 * `.rah-map-node` rule declares `font-size: 10px`. Only the base rule — the
 * child element rules (`.rah-map-node__title`, `__icon`) and the state rules
 * (`:hover` and friends) are left alone by this pin.
 *
 * A CSS declaration's absence is invisible to the type system, and this
 * harness runs node-env vitest with no jsdom, so the pin reads the checked-in
 * stylesheet source and asserts against its text — the same source-text
 * pinning as tests/unit/belief/beliefMapFixedBadgeCss.test.ts.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

// Absolute path of the checked-in map stylesheet, resolved from this test
// file so the read never depends on the process working directory.
const mapStylesheetPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../src/components/panes/map/map-styles.css'
);

// The map stylesheet source, read once for every assertion in this file.
const mapStylesheetSource = fs.readFileSync(mapStylesheetPath, 'utf8');

// The base class whose font-size this pin owns.
const mapNodeClassName = 'rah-map-node';

// The size the base rule must declare, in px. See the file header for why.
const intendedMapNodeLabelFontSizePx = 10;

/**
 * Extracts the body text of the BASE rule for the given class. The `\s*\{`
 * after the exact class name is what keeps this reading the base rule only:
 * `.rah-map-node__title` and `.rah-map-node:hover` both continue with a
 * non-brace character and so are never matched. The map stylesheet contains
 * only flat rules, so "everything up to the first closing brace" is the whole
 * rule body. Throws a named error when the class is missing, because a
 * missing rule is a different failure from a wrong declaration inside one.
 */
function readBaseClassDeclarations(cssClassName: string): string {
  const baseClassRuleMatch = mapStylesheetSource.match(
    new RegExp(String.raw`\.${cssClassName}\s*\{([^}]*)\}`)
  );
  if (!baseClassRuleMatch) {
    throw new Error(`map-styles.css declares no base .${cssClassName} rule`);
  }
  return baseClassRuleMatch[1];
}

/**
 * Parses the px number of a `font-size:`-style declaration out of one rule
 * body, or null when the property is missing or is not expressed in px. Both
 * of those failure modes surface as null and fail the pin with the property
 * named, rather than comparing as NaN.
 */
function readPxDeclaration(ruleDeclarations: string, propertyName: string): number | null {
  const pxDeclarationMatch = ruleDeclarations.match(
    new RegExp(String.raw`(?:^|;|\s)${propertyName}\s*:\s*([\d.]+)px\b`)
  );
  return pxDeclarationMatch ? Number(pxDeclarationMatch[1]) : null;
}

describe('map node label size in map-styles.css', () => {
  // The base rule must exist at all — every other assertion here reads it,
  // and a renamed or deleted rule is its own distinct failure.
  it(`declares a base .${mapNodeClassName} rule`, () => {
    expect(
      readBaseClassDeclarations(mapNodeClassName),
      `map-styles.css must declare a base .${mapNodeClassName} rule`
    ).toBeTruthy();
  });

  // THE PIN: the base rule sizes the node's label at 10px, down from the 11px
  // that reads oversized against a real graph.
  it(`sizes the node label at ${intendedMapNodeLabelFontSizePx}px`, () => {
    const mapNodeDeclarations = readBaseClassDeclarations(mapNodeClassName);
    const mapNodeLabelFontSizePx = readPxDeclaration(mapNodeDeclarations, 'font-size');
    expect(
      mapNodeLabelFontSizePx,
      `.${mapNodeClassName} must declare font-size in px`
    ).not.toBeNull();
    expect(
      mapNodeLabelFontSizePx,
      `.${mapNodeClassName} must size its label at ${intendedMapNodeLabelFontSizePx}px; 11px reads oversized against a real graph`
    ).toBe(intendedMapNodeLabelFontSizePx);
  });
});
