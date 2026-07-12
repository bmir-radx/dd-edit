// Cross-platform `npm run build:sidecar`: run sidecar/build_binary.py with
// the sidecar venv's Python (POSIX and Windows lay the venv out differently).
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const sidecar = path.join(root, 'sidecar')
const python =
  process.platform === 'win32'
    ? path.join(sidecar, '.venv', 'Scripts', 'python.exe')
    : path.join(sidecar, '.venv', 'bin', 'python')

if (!existsSync(python)) {
  console.error(
    `No sidecar venv Python at ${python}.\n` +
      'Create it first: cd sidecar && python -m venv .venv && <venv pip> install -e ".[build]"',
  )
  process.exit(1)
}

const result = spawnSync(python, [path.join(sidecar, 'build_binary.py')], { stdio: 'inherit' })
process.exit(result.status ?? 1)
