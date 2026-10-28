/**
 * dsh-pet dev launcher: builds when asked, then starts the Electron carrier.
 * Packaging (electron-builder) is deliberately out of MVP scope; this script
 * runs the carrier straight from the workspace build.
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = join(here, '..')

const skipBuild = process.argv.includes('--skip-build')

if (!skipBuild) {
  const build = spawn('pnpm', ['run', 'build'], {
    cwd: appRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  await new Promise<void>((resolveBuild, rejectBuild) => {
    build.on('exit', (code) => {
      if (code === 0) resolveBuild()
      else rejectBuild(new Error(`pet build failed with code ${String(code)}`))
    })
  })
}

const electron = await import('electron')
const electronBinary = (electron as unknown as { default: string }).default
const child = spawn(electronBinary, ['.'], {
  cwd: appRoot,
  stdio: 'inherit',
  env: process.env,
})
child.on('exit', (code) => {
  process.exitCode = code ?? 0
})
