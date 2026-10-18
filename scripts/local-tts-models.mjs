import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
const manifest = JSON.parse(readFileSync(new URL('./local-tts-models.json', import.meta.url), 'utf8'));
export const MELO_REVISION = manifest.revision;
export const MELO_REPOSITORY = manifest.repository;
export const MELO_FILES = manifest.files;
