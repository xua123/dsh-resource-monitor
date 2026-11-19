/**
 * dsh-server-monitor — browser half.
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
  id: 'dsh-server-monitor',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const FRAME_SRC = '/dsh-server-monitor/'
    const VIEW_ID = 'dsh-server-monitor'

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
          title: '资源监控',
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


    function openResourcePanel(wsKey) {
      const old = document.getElementById('dsh-server-monitor-panel')
      if (old) old.remove()
      const overlay = document.createElement('div')
      overlay.id = 'dsh-server-monitor-panel'
      Object.assign(overlay.style, {
        position: 'fixed', inset: '0', zIndex: '2147483000',
        background: 'rgba(0,0,0,.22)', display: 'flex', justifyContent: 'flex-end',
        padding: '18px', boxSizing: 'border-box',
      })
      const panel = document.createElement('div')
      Object.assign(panel.style, {
        width: 'min(920px, calc(100vw - 36px))', height: '100%', display: 'flex',
        flexDirection: 'column', overflow: 'hidden', borderRadius: '14px',
        border: '1px solid rgba(127,127,127,.35)', background: 'rgba(22,22,25,.97)',
        boxShadow: '0 24px 80px rgba(0,0,0,.45)',
      })
      const header = document.createElement('div')
      Object.assign(header.style, {
        display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 12px',
        borderBottom: '1px solid rgba(127,127,127,.25)', color: '#f1f1f3',
        font: '12px/1.2 system-ui, sans-serif',
      })
      const title = document.createElement('span')
      title.textContent = '资源监控'
      title.style.fontWeight = '600'
      const spacer = document.createElement('span')
      spacer.style.flex = '1'
      const close = document.createElement('button')
      close.type = 'button'
      close.textContent = '关闭'
      Object.assign(close.style, {
        border: '1px solid rgba(127,127,127,.35)', borderRadius: '6px',
        background: 'transparent', color: '#d8d8dc', font: '11px/1 system-ui, sans-serif',
        padding: '6px 9px', cursor: 'pointer',
      })
      header.append(title, spacer, close)
      const frame = document.createElement('iframe')
      frame.title = '资源监控'
      Object.assign(frame.style, {
        flex: '1 1 auto', width: '100%', border: '0', display: 'block',
        background: 'transparent', colorScheme: isDark() ? 'dark' : 'light',
      })
      const query = ['theme=' + (isDark() ? 'dark' : 'light')]
      if (typeof wsKey === 'string' && wsKey.trim() !== '') {
        query.push('scope=workspace', 'ws=' + encodeURIComponent(wsKey.trim()))
      }
      frame.src = FRAME_SRC + '?' + query.join('&')
      panel.append(header, frame)
      overlay.appendChild(panel)
      const dismiss = () => {
        overlay.remove()
        document.removeEventListener('keydown', onKey)
      }
      const onKey = (event) => { if (event.key === 'Escape') dismiss() }
      overlay.addEventListener('click', (event) => { if (event.target === overlay) dismiss() })
      close.addEventListener('click', dismiss)
      document.addEventListener('keydown', onKey)
      document.body.appendChild(overlay)
    }

    function installWorkspaceMenuEntry(ctx) {
      if (typeof document === 'undefined') return () => {}
      let workspaceKey = ''
      let scanTimer = 0
      let observer = null
      let pollTimer = 0
      const removeInjected = () => {
        for (const node of Array.from(document.querySelectorAll('[data-dsh-monitor-workspace-menu]'))) node.remove()
      }
      const isRename = (text) => text === '重命名' || /^rename$/i.test(text)
      const isDelete = (text) => text.includes('删除工作区') || /delete workspace/i.test(text)
      const deepest = (scope, predicate) => {
        let best = null
        for (const element of Array.from(scope.querySelectorAll('*'))) {
          const text = (element.textContent || '').trim()
          if (text !== '' && predicate(text)) best = element
        }
        return best
      }
      const findMenu = () => {
        for (const menu of Array.from(document.querySelectorAll('[role="menu"]'))) {
          const text = menu.textContent || ''
          if (isDelete(text) && /重命名|rename/i.test(text)) return menu
        }
        return null
      }
      const inject = (menu) => {
        if (menu.querySelector('[data-dsh-monitor-workspace-menu]') !== null) return true
        const rename = deepest(menu, isRename)
        const del = deepest(menu, isDelete)
        if (!rename || !del) return false
        let list = rename.parentElement
        while (list && !list.contains(del)) list = list.parentElement
        if (!list) return false
        let item = rename
        while (item.parentElement && item.parentElement !== list) item = item.parentElement
        let deleteItem = del
        while (deleteItem.parentElement && deleteItem.parentElement !== list) deleteItem = deleteItem.parentElement
        const row = item.cloneNode(true)
        row.setAttribute('data-dsh-monitor-workspace-menu', '')
        const label = deepest(row, isRename)
        if (label && label.children.length === 0) label.textContent = '资源监控'
        else row.textContent = '资源监控'
        row.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) } catch { /* ignore */ }
          openResourcePanel(workspaceKey)
        }, true)
        list.insertBefore(row, deleteItem)
        return true
      }
      const scan = () => {
        try {
          const menu = findMenu()
          if (menu) inject(menu)
        } catch { /* ignore */ }
      }
      const schedule = () => {
        if (scanTimer !== 0) return
        scanTimer = window.setTimeout(() => { scanTimer = 0; scan() }, 60)
      }
      const onPointer = (event) => {
        schedule()
        try {
          const row = event.target && typeof event.target.closest === 'function'
            ? event.target.closest('[data-row-key^="workspace:"]')
            : null
          if (row) workspaceKey = String(row.getAttribute('data-row-key') || '').slice('workspace:'.length)
        } catch { /* ignore */ }
      }
      document.addEventListener('click', onPointer, true)
      document.addEventListener('pointerdown', onPointer, true)
      observer = new MutationObserver(schedule)
      observer.observe(document.body, { childList: true, subtree: true })
      pollTimer = window.setInterval(() => {
        if (document.querySelector('[role="menu"]') !== null) scan()
      }, 500)
      const cleanup = () => {
        if (pollTimer !== 0) window.clearInterval(pollTimer)
        pollTimer = 0
        if (observer) observer.disconnect()
        observer = null
        if (scanTimer !== 0) window.clearTimeout(scanTimer)
        scanTimer = 0
        document.removeEventListener('click', onPointer, true)
        document.removeEventListener('pointerdown', onPointer, true)
        removeInjected()
      }
      removeInjected()
      if (ctx && typeof ctx.effect === 'function') ctx.effect(() => cleanup)
      return cleanup
    }

    function apply(ctx) {
      const slots = ctx.slots
      if (!slots || typeof slots.register !== 'function') return
      try { installWorkspaceMenuEntry(ctx) } catch { /* optional */ }

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
          { name: 'conversation.view', id: VIEW_ID, order: 46, label: () => '资源监控' },
          WorkspaceMonitorFrame,
        ))
      } catch {
        /* older shell without conversation.view */
      }
    }

    return { name: 'dsh-server-monitor', inject: ['slots'], apply }
  },
})
