/**
 * dsh-server-lens — browser half.
 *
 * The dashboard itself is a plain HTML page served by the host half, because a
 * resource monitor needs no React state to be useful. This half seats that page
 * in two places that belong to the product shell:
 *
 *   • `sidebar.panellist` — an icon in the LEFT sidebar, and
 *   • `main` — the global panel that icon selects (not a conversation tab).
 *
 * Bundle convention: `window.__ModuleLoader__.load({ id, factory })` where the
 * factory is a CommonJS-style module body. `require('react')` resolves against
 * the web shell's frozen module table, so nothing here is bundled twice.
 */
window.__ModuleLoader__.load({
  id: 'dsh-server-lens',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const FRAME_SRC = '/dsh-server-lens/'
    const VIEW_ID = 'dsh-server-lens'

    function isDark() {
      try {
        if (document.body && document.body.hasAttribute('data-ds-dark-theme')) return true
        const root = document.documentElement
        if (root && (root.getAttribute('data-theme') === 'dark' || root.classList.contains('dark'))) return true
      } catch {
        /* a missing document during SSR must not break the component */
      }
      return false
    }

    function extractWorkspaceInfo(props) {
      if (!props || typeof props !== 'object') return { host: '', wsKey: '' }
      const hostCandidates = [
        props.host,
        props.hostname,
        props.ip,
        props.remoteHost,
        props.sshHost,
        props.machine && props.machine.host,
        props.machine && props.machine.id,
        props.workspace && props.workspace.host,
        props.workspace && props.workspace.remoteHost,
        props.workspace && props.workspace.machineId,
        props.workspace && props.workspace.machine && props.workspace.machine.host,
        props.conversation && props.conversation.workspace && props.conversation.workspace.host,
        props.conversation && props.conversation.machine && props.conversation.machine.host,
      ]
      let host = ''
      for (const item of hostCandidates) {
        if (typeof item === 'string' && item.trim() !== '') {
          host = item.trim()
          break
        }
      }
      if (!host) {
        const pathCand = (props.workspace && props.workspace.path) || props.workspacePath || props.cwd || ''
        if (typeof pathCand === 'string' && /^[A-Za-z]:[\\/]/.test(pathCand.trim())) {
          host = 'local'
        }
      }
      const keyCandidates = [
        props.workspaceId,
        props.conversationId,
        props.workspace && (props.workspace.id || props.workspace.path),
        props.conversation && props.conversation.id,
      ]
      let wsKey = ''
      for (const k of keyCandidates) {
        if (typeof k === 'string' && k.trim() !== '') {
          wsKey = k.trim()
          break
        }
      }
      const pathCandidates = [
        props.workspace && props.workspace.path,
        props.workspace && props.workspace.cwd,
        props.workspacePath,
        props.cwd,
        props.session && props.session.cwd,
        props.conversation && props.conversation.cwd,
      ]
      let wsPath = ''
      for (const item of pathCandidates) {
        if (typeof item === 'string' && item.trim() !== '') {
          wsPath = item.trim()
          break
        }
      }
      const sessionCandidates = [
        props.sessionId,
        props.session && props.session.id,
        props.session && props.session.sessionId,
        props.conversation && props.conversation.id,
        props.conversation && props.conversation.sessionId,
      ]
      let session = ''
      for (const item of sessionCandidates) {
        if (typeof item === 'string' && item.trim() !== '') {
          session = item.trim()
          break
        }
      }
      return { host, wsKey, path: wsPath, session }
    }

    function MonitorFrame(props) {
      const [dark, setDark] = React.useState(isDark)
      const isWorkspace = Boolean(props && props.__workspaceScope)
      const wsInfo = isWorkspace ? extractWorkspaceInfo(props) : { host: '', wsKey: '', path: '', session: '' }

      React.useEffect(() => {
        if (typeof MutationObserver !== 'function') return undefined
        const sync = () => setDark(isDark())
        const observer = new MutationObserver(sync)
        if (document.body) {
          observer.observe(document.body, {
            attributes: true,
            attributeFilter: ['data-ds-dark-theme', 'class', 'data-theme'],
          })
        }
        observer.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['data-theme', 'class'],
        })
        sync()
        return () => observer.disconnect()
      }, [])

      const qs = [`theme=${dark ? 'dark' : 'light'}`]
      if (isWorkspace) qs.push('scope=workspace')
      if (wsInfo.host) qs.push(`host=${encodeURIComponent(wsInfo.host)}`)
      if (wsInfo.wsKey) qs.push(`ws=${encodeURIComponent(wsInfo.wsKey)}`)
      if (wsInfo.path) qs.push(`path=${encodeURIComponent(wsInfo.path)}`)
      if (wsInfo.session) qs.push(`session=${encodeURIComponent(wsInfo.session)}`)
      const src = `${FRAME_SRC}?${qs.join('&')}`
      return h(
        'div',
        {
          style: {
            width: '100%',
            height: '100%',
            minHeight: '520px',
            display: 'flex',
            overflow: 'hidden',
          },
        },
        h('iframe', {
          src,
          title: '服务器资源监控',
          style: {
            flex: '1 1 auto',
            width: '100%',
            height: '100%',
            border: '0',
            display: 'block',
            background: 'transparent',
            colorScheme: dark ? 'dark' : 'light',
          },
        }),
      )
    }

    /** Left-sidebar icon: a small server rack. */
    function ServerIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 18
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('rect', { x: 3, y: 4, width: 18, height: 6, rx: 1.6 }),
        h('rect', { x: 3, y: 14, width: 18, height: 6, rx: 1.6 }),
        h('path', { d: 'M7 7h.01M7 17h.01' }),
      )
    }

    function apply(ctx) {
      const slots = ctx.slots
      if (!slots || typeof slots.register !== 'function') return

      // Global panel body: selecting the left-sidebar entry renders this.
      try {
        slots.inject('main', () => slots.register(
          { name: 'main', key: VIEW_ID },
          MonitorFrame,
        ))
      } catch {
        /* older shell without a keyed main slot */
      }

      // Left sidebar entry.
      try {
        slots.inject('sidebar.panellist', () => slots.register(
          {
            name: 'sidebar.panellist',
            id: VIEW_ID,
            order: 40,
            label: () => '服务器资源',
          },
          ServerIcon,
        ))
      } catch {
        /* sidebar.panellist is optional */
      }

      function WorkspaceMonitorFrame(props) {
        return h(MonitorFrame, { ...(props || {}), __workspaceScope: true })
      }

      // Conversation / workspace top tab (next to 对话 / 轨迹 / 上下文 / 编队).
      try {
        slots.inject('conversation.view', () => slots.register(
          { name: 'conversation.view', id: VIEW_ID, order: 46, label: () => '服务器资源' },
          WorkspaceMonitorFrame,
        ))
      } catch {
        /* older shell without conversation.view */
      }
    }

    return { name: 'dsh-server-lens', inject: ['slots'], apply }
  },
})
