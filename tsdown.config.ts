import { defineConfig } from 'tsdown'
import { decoratorPlugin } from './vendor/typert-plugin/tsdown-plugin.js'

/**
 * Package-local override for the npm release build: the workspace deps the
 * shared tsdown config leaves external (@deepseek-ai/dsh-tools and friends,
 * none of which are published to npm) are bundled INTO lib/index.js so the
 * published package is self-contained. @deepseek-ai/cordis stays external —
 * it is a peerDependency provided by the host runtime, and bundling it would
 * create a second cordis instance (identity-based hooks would split).
 *
 * This repo is the release home; the tsdown build itself still runs in the
 * dsh monorepo workspace (dev upstream) where the bundled deps resolve, and
 * `scripts/sync-from-monorepo.cmd` carries the output here. The decorator
 * plugin is vendored under ./vendor/typert-plugin/ (closure of the monorepo's
 * typert/generator/lib/types build products) so this config stays honest.
 * Do NOT sync this file from the monorepo — the two copies point at
 * different plugin locations on purpose.
 */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/tools.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  plugins: [decoratorPlugin()],
  noExternal: [
    /@deepseek-ai\/dsh-tools/,
    /@deepseek-ai\/dsh-pet$/,
    /@deepseek-ai\/dsh-client-connection/,
    /@deepseek-ai\/dsh-host-webserver/,
  ],
})
