// Hash routes, which keep the static server trivial.
import { useEffect, useState } from 'react'

export type Route =
  | { name: 'chat'; sessionId?: string; agent?: string }
  | { name: 'agents' }
  | { name: 'skills' }
  | { name: 'settings' }

export function parseRoute(hash: string): Route {
  const [path = '', search = ''] = hash.replace(/^#\/?/, '').split('?')
  const [section, id] = path.split('/')
  switch (section) {
    case 'agents':
      return { name: 'agents' }
    case 'skills':
      return { name: 'skills' }
    case 'settings':
      return { name: 'settings' }
    default: {
      const agent = new URLSearchParams(search).get('agent')
      return { name: 'chat', ...(id ? { sessionId: decodeSegment(id) } : {}), ...(agent ? { agent } : {}) }
    }
  }
}

/** A malformed escape in a pasted link must not crash the app; the raw segment then fails as an unknown session. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

export function routeHash(route: Route): string {
  if (route.name !== 'chat') return `#/${route.name}`
  const base = route.sessionId ? `#/chat/${encodeURIComponent(route.sessionId)}` : '#/chat'
  return route.agent ? `${base}?agent=${encodeURIComponent(route.agent)}` : base
}

export function navigate(route: Route): void {
  window.location.hash = routeHash(route)
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash))
  useEffect(() => {
    const onChange = (): void => setRoute(parseRoute(window.location.hash))
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}
