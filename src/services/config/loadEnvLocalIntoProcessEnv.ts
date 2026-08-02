/**
 * Loads `.env.local` into process.env for entry points that run outside the
 * Next.js app (e.g. `scripts/rebuild-embeddings.ts` under plain tsx), where
 * nothing else reads the file. Semantics mirror Next.js's `.env.local`
 * handling: the real environment ALWAYS wins — a key already present in
 * process.env (even as an empty string, which is a deliberate setting) is
 * never overwritten, so inline overrides like
 * `EMBEDDING_PROFILE=x npm run rebuild:embeddings` keep working. Only keys
 * absent from process.env are populated from the file.
 *
 * The file is resolved from process.cwd() AT CALL TIME — the same rule as
 * src/services/storage/envLocalServer.ts — and parsed explicitly rather than
 * via process.loadEnvFile, whose own path resolution would bypass that rule.
 * A missing or unreadable `.env.local` is not an error: many machines keep
 * their whole profile in the real environment.
 */

import fs from 'fs';
import path from 'path';

// Matches one `KEY=value` line: an env-style identifier, `=`, then the rest
// of the line as the raw value.
const ENV_LINE_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

// Strip one matching pair of surrounding single or double quotes, matching
// the repo's other `.env.local` parsers (see envLocalServer.ts).
function stripSurroundingQuotes(rawValue: string): string {
  if (
    (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
    (rawValue.startsWith("'") && rawValue.endsWith("'"))
  ) {
    return rawValue.slice(1, -1);
  }
  return rawValue;
}

export function loadEnvLocalIntoProcessEnv(): void {
  const envLocalPath = path.join(process.cwd(), '.env.local');

  let envLocalContents: string;
  try {
    envLocalContents = fs.readFileSync(envLocalPath, 'utf8');
  } catch {
    // Missing or unreadable file: leave process.env untouched.
    return;
  }

  for (const line of envLocalContents.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith('#')) continue;

    const keyValueMatch = ENV_LINE_PATTERN.exec(trimmedLine);
    if (!keyValueMatch) continue;

    const [, envKey, rawValue] = keyValueMatch;
    if (process.env[envKey] !== undefined) continue; // real environment wins

    process.env[envKey] = stripSurroundingQuotes(rawValue.trim());
  }
}
