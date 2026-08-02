import fs from 'fs';
import path from 'path';

// Template placeholders that must never be treated as real keys.
const OPENAI_KEY_PLACEHOLDER = 'your-openai-api-key-here';
const VOYAGE_KEY_PLACEHOLDER = 'your-voyage-api-key-here';

// Find the first `<envKeyName>=` line in .env.local contents and return its
// value with surrounding quotes stripped. Comment lines are skipped; an empty
// value or the given placeholder resolves to undefined (unconfigured).
function parseKeyFromEnvFile(
  contents: string,
  envKeyName: string,
  placeholder: string
): string | undefined {
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (!trimmed.startsWith(`${envKeyName}=`)) continue;
    const raw = trimmed.slice(`${envKeyName}=`.length).trim();
    const value =
      (raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))
        ? raw.slice(1, -1)
        : raw;
    if (!value || value === placeholder) return undefined;
    return value;
  }
  return undefined;
}

// Re-read .env.local from process.cwd() on every call (the settings UI writes
// keys there at runtime) and return the named key, or undefined when the file
// is missing/unreadable or the key is unconfigured.
function readKeyFromEnvLocal(envKeyName: string, placeholder: string): string | undefined {
  const envPath = path.join(process.cwd(), '.env.local');
  try {
    const fileKey = parseKeyFromEnvFile(fs.readFileSync(envPath, 'utf8'), envKeyName, placeholder);
    if (fileKey) return fileKey;
  } catch {
    // Ignore missing/unreadable .env.local and treat that as "not configured" for local mode.
  }
  return undefined;
}

export function getPreferredOpenAiKey(): string | undefined {
  return readKeyFromEnvLocal('OPENAI_API_KEY', OPENAI_KEY_PLACEHOLDER);
}

export function hasPreferredOpenAiKey(): boolean {
  const key = getPreferredOpenAiKey();
  return Boolean(key && key.startsWith('sk-') && key.length > 20);
}

// Voyage keys start 'pa-', never 'sk-', so no prefix check applies here.
export function getPreferredVoyageKey(): string | undefined {
  return readKeyFromEnvLocal('VOYAGE_API_KEY', VOYAGE_KEY_PLACEHOLDER);
}
