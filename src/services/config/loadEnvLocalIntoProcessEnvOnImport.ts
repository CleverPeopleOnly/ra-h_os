/**
 * Side-effect module: importing it runs loadEnvLocalIntoProcessEnv().
 *
 * Exists for script entry points whose OTHER imports read process.env while
 * their modules load (e.g. src/services/database/sqlite-client.ts). ESM
 * evaluates imports before any statement in the importing module, so a plain
 * "call the loader first" line in the script body would run too late — the
 * only way to load `.env.local` ahead of those imports is to make this
 * module the script's first import.
 */

import { loadEnvLocalIntoProcessEnv } from './loadEnvLocalIntoProcessEnv';

loadEnvLocalIntoProcessEnv();
