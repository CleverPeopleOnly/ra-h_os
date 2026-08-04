/**
 * SLICE 4 of the belief map overlay — the source-text pin that the visual
 * map node (src/components/panes/map/RahNode.tsx) actually WEARS the belief
 * ring. This harness runs node-env vitest with no jsdom, so a component
 * cannot be rendered; the component's consumption is pinned by reading its
 * checked-in source and asserting against the text — the same source-text
 * pinning as beliefThemeTokens.test.ts and beliefMapRingClasses.test.ts,
 * with regex tolerance for formatting throughout.
 *
 * The contract pinned here:
 *  - RahNode reads data.beliefPresentation (dot access or destructuring —
 *    both accepted),
 *  - it imports beliefMapNodeRingClassNames from the belief presentation
 *    module and calls it on that presentation,
 *  - the call's result lands INSIDE the rendered className expression, in an
 *    array-flattening form (spread, .concat(, or .join() — an unflattened
 *    array interpolated into a string stringifies as "a,b" and corrupts the
 *    class attribute,
 *  - FUNNEL RULE (carried from slice 3, GUARD pins green today): RahNode
 *    must NOT import deriveBeliefPresentation or the shared MCP mapper, and
 *    must not read any belief_ column off the row. The derivation happens
 *    exactly once, in toRFNodes (utils.ts), which threads the finished
 *    decision in as data.beliefPresentation; a second derivation site could
 *    drift from the first and put two disagreeing rings on screen.
 *
 * Red today: the reference, import, call, inclusion and flatten pins (the
 * component has no belief code yet). Green today, flagged as GUARD: the
 * funnel-rule pins and the base-class pin — they exist to stay green.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

// Absolute path of the checked-in visual map node component, resolved from
// this test file so the read never depends on the process working directory.
const rahNodeComponentPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../src/components/panes/map/RahNode.tsx'
);

// The component source, read once for every assertion in this file.
const rahNodeComponentSource = fs.readFileSync(rahNodeComponentPath, 'utf8');

// Extracts the FIRST className={...} expression in the component — the outer
// node <div>'s class composition (every other className in the file is a
// plain string attribute, which `className={` does not match). Brace-counted
// rather than regexed so nested object/template braces inside the expression
// stay balanced; a string literal containing an unbalanced brace would break
// the count, and none exists in a class composition.
function readRahNodeClassNameExpression(): string {
  const classNameAttributeMarker = 'className={';
  const attributeStartIndex = rahNodeComponentSource.indexOf(classNameAttributeMarker);
  if (attributeStartIndex === -1) {
    throw new Error('RahNode.tsx has no className={...} expression to compose classes in');
  }
  const expressionStartIndex = attributeStartIndex + classNameAttributeMarker.length;
  // Depth of unclosed braces inside the expression; the attribute's own
  // opening brace is depth 1, and depth 0 marks its close.
  let unclosedBraceDepth = 1;
  for (
    let sourceIndex = expressionStartIndex;
    sourceIndex < rahNodeComponentSource.length;
    sourceIndex++
  ) {
    if (rahNodeComponentSource[sourceIndex] === '{') unclosedBraceDepth++;
    if (rahNodeComponentSource[sourceIndex] === '}') {
      unclosedBraceDepth--;
      if (unclosedBraceDepth === 0) {
        return rahNodeComponentSource.slice(expressionStartIndex, sourceIndex);
      }
    }
  }
  throw new Error('RahNode.tsx className={...} expression never closes its brace');
}

// The identifier by which the ring class names appear inside the className
// expression: the helper called inline, or the local a `const`/`let` binds
// its result to. Throws a readable error when the component neither calls
// the helper inside the expression nor binds its result anywhere — the
// missing-consumption failure mode of the red.
function beliefRingClassNamesIdentifierInClassNameExpression(): string {
  const classNameExpression = readRahNodeClassNameExpression();
  if (/beliefMapNodeRingClassNames\s*\(/.test(classNameExpression)) {
    return 'beliefMapNodeRingClassNames';
  }
  const resultBindingMatch = rahNodeComponentSource.match(
    /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*beliefMapNodeRingClassNames\s*\(/
  );
  if (!resultBindingMatch) {
    throw new Error(
      'RahNode.tsx neither calls beliefMapNodeRingClassNames inside className nor binds its result to a local'
    );
  }
  return resultBindingMatch[1];
}

describe('RahNode.tsx consumes the threaded belief presentation', () => {
  // The component must read the presentation slice 3 threaded into its data
  // — by dot access or by destructuring it from `data`, both accepted.
  it('references data.beliefPresentation', () => {
    const readsByDotAccess = /data\s*\.\s*beliefPresentation\b/.test(rahNodeComponentSource);
    const readsByDestructuring = /\{[^{}]*\bbeliefPresentation\b[^{}]*\}\s*=\s*data\b/.test(
      rahNodeComponentSource
    );
    expect(
      readsByDotAccess || readsByDestructuring,
      'RahNode.tsx must read beliefPresentation off its data (dot access or destructuring)'
    ).toBe(true);
  });

  // The class names come from the one belief class-name owner — imported,
  // never re-derived or hand-composed in the component.
  it('imports beliefMapNodeRingClassNames from the belief presentation module', () => {
    expect(rahNodeComponentSource).toMatch(
      /import\s*\{[^}]*\bbeliefMapNodeRingClassNames\b[^}]*\}\s*from\s*['"]@\/services\/belief\/beliefPresentation['"]/
    );
  });

  // The helper is called ON the threaded presentation — any argument text
  // mentioning beliefPresentation is accepted (data.beliefPresentation, a
  // destructured beliefPresentation, an optional-chained read, …).
  it('calls beliefMapNodeRingClassNames on the belief presentation', () => {
    expect(rahNodeComponentSource).toMatch(
      /beliefMapNodeRingClassNames\s*\([^)]*beliefPresentation/
    );
  });
});

describe('RahNode.tsx wears the ring class names in its className composition', () => {
  // The result must land inside the rendered className expression — either
  // the call itself or the local its result was bound to. Anything else
  // (computed but never worn) leaves the node visually beliefless.
  it('includes the helper result inside the className expression', () => {
    const ringClassNamesIdentifier = beliefRingClassNamesIdentifierInClassNameExpression();
    expect(
      readRahNodeClassNameExpression(),
      `className must reference ${ringClassNamesIdentifier}`
    ).toContain(ringClassNamesIdentifier);
  });

  // The result is a string[], so it must enter the composition in a form
  // that flattens it to individual class tokens: spread into the class
  // array (...x), concatenated onto it (.concat(x), or joined itself
  // (x.join(). An array dropped into a template or joined array unflattened
  // stringifies as "a,b" — one bogus comma-glued class.
  it('flattens the helper result into the composition (spread, .concat, or .join)', () => {
    const ringClassNamesIdentifier = beliefRingClassNamesIdentifierInClassNameExpression();
    const classNameExpression = readRahNodeClassNameExpression();
    // The three accepted flattening forms around the identifier. The
    // identifier is a plain word, so raw interpolation is regex-safe.
    const flattenedBySpread = new RegExp(String.raw`\.\.\.\s*${ringClassNamesIdentifier}\b`);
    const flattenedByConcat = new RegExp(String.raw`\.concat\(\s*${ringClassNamesIdentifier}\b`);
    const flattenedByOwnJoin = new RegExp(
      String.raw`${ringClassNamesIdentifier}\s*\([^)]*\)\s*\.join\(|${ringClassNamesIdentifier}\s*\.join\(`
    );
    const flattensTheRingClasses =
      flattenedBySpread.test(classNameExpression) ||
      flattenedByConcat.test(classNameExpression) ||
      flattenedByOwnJoin.test(classNameExpression);
    expect(
      flattensTheRingClasses,
      `className must flatten ${ringClassNamesIdentifier} (spread / .concat( / .join(), not interpolate the array`
    ).toBe(true);
  });

  // GUARD (green today): the base node class survives the composition
  // rewrite — the ring classes ride BESIDE rah-map-node, never replace it.
  it('keeps the rah-map-node base class in the composition', () => {
    expect(readRahNodeClassNameExpression()).toContain('rah-map-node');
  });
});

describe('RahNode.tsx honours the derivation funnel (guard pins, green today)', () => {
  // GUARD: the component consumes the FINISHED decision only. Importing the
  // derivation function here would create a second derivation site that can
  // drift from toRFNodes' — two disagreeing rings for one node.
  it('does not import deriveBeliefPresentation', () => {
    expect(rahNodeComponentSource).not.toMatch(/\bderiveBeliefPresentation\b/);
  });

  // GUARD: nor may it reach past the presentation to the shared MCP mapper —
  // the mapper feeds the derivation module, not components.
  it('does not import the shared belief MCP mapper', () => {
    expect(rahNodeComponentSource).not.toMatch(/beliefMcpToolContract/);
  });

  // GUARD: no direct belief column reads (belief_credence,
  // belief_evidence_for_mass, …) — the raw columns stop at toRFNodes, and a
  // component reading them would re-decide what the presentation module
  // already decided (the `?? 0` bug's favourite doorway).
  it('reads no belief_ column directly', () => {
    expect(rahNodeComponentSource).not.toMatch(/\bbelief_[a-z]/);
  });
});
