/**
 * Generate the renderer's document types from the toolkit's dd-json JSON
 * Schema. The schema copy in this directory is vendored from the toolkit repo
 * at the same tag the sidecar pins (see sidecar/pyproject.toml); refresh it
 * with:
 *
 *   curl -sf https://raw.githubusercontent.com/bmir-radx/radx-data-dictionary-specification/vX.Y.Z/api/dd_api/dd-json.schema.json \
 *     -o scripts/dd-json.schema.json && npm run gen:types
 *
 * The generated file is committed so builds need no network.
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { compileFromFile } from 'json-schema-to-typescript'

const schema = fileURLToPath(new URL('./dd-json.schema.json', import.meta.url))
const out = fileURLToPath(new URL('../src/renderer/src/types/dd-json.gen.ts', import.meta.url))

const ts = await compileFromFile(schema, {
  bannerComment:
    '/* eslint-disable */\n' +
    '// GENERATED from scripts/dd-json.schema.json — do not edit by hand.\n' +
    '// Regenerate with: npm run gen:types',
  additionalProperties: false,
})

writeFileSync(out, ts)
console.log(`wrote ${out}`)
