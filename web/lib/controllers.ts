// One controller per session, kept across navigation so that a running turn keeps streaming while the user looks at
// another page.
import { browserTransport } from './api.ts'
import { SessionController } from './session-controller.ts'

const controllers = new Map<string, SessionController>()

export function getController(sessionId: string, onTurnSettled?: () => void): SessionController {
  let controller = controllers.get(sessionId)
  if (!controller) {
    controller = new SessionController(sessionId, browserTransport, onTurnSettled)
    controllers.set(sessionId, controller)
  }
  return controller
}

export function disposeController(sessionId: string): void {
  controllers.get(sessionId)?.dispose()
  controllers.delete(sessionId)
}

/** Sessions belong to one region, so their streams must not reconnect after the region changes. */
export function disposeAllControllers(): void {
  for (const sessionId of [...controllers.keys()]) disposeController(sessionId)
}
