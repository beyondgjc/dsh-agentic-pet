/**
 * dsh-pet profile runner child. Runs the `pet` profile through the shared CLI
 * profile runner inside Electron's Node mode and reports the authenticated
 * web URL to the carrier over Node IPC. Mirrors apps/desktop-host minus the
 * desktop-only machinery (office engine, file drag, update tasks, quit
 * inspection): the pet surface needs the webserver, Connection, and the API
 * gateway stack and nothing else.
 */

import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'

async function main(): Promise<void> {
  const application = await runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: 'pet',
    patchFiles: [],
    args: ['--no-open', '--host', '127.0.0.1', '--port', '0'],
  })
  const { ctx, shutdown } = application
  const webServer = ctx.get('webServer')
  const connection = ctx.get('connection')
  if (webServer === undefined || connection === undefined) {
    throw new Error('pet host: the pet profile booted without the web surface stack')
  }
  const url = connection.authenticatedUrl(`${webServer.protocol}//127.0.0.1:${String(webServer.port)}`)
  process.send?.({ type: 'ready', url })

  let stopping: Promise<void> | undefined
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      try {
        await shutdown.shutdown(0)
      } finally {
        process.send?.({ type: 'shutdown-complete' })
        process.disconnect()
        process.exit(0)
      }
    })()
    return stopping
  }
  process.on('message', (message: unknown) => {
    if ((message as { type?: string } | null)?.type === 'shutdown') void stop()
  })
  // The carrier dying takes the profile with it: a disconnected IPC channel
  // means nobody owns this tree anymore.
  process.once('disconnect', () => { void stop() })
}

await main()
