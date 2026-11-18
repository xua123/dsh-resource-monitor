/**
 * dsh-server-monitor — browser half.
 *
 * The dashboard itself is a plain HTML page served by the host half, because a
 * resource monitor needs no React state to be useful. This half only seats that
 * page in two places:
 *
 *   • a `conversation.view` tab next to Chat / Context, and
 *   • a right-sidebar pane with a guide entry, so it can live beside the chat.
 *
 * Both render one iframe; theme is forwarded once at mount and re-applied when
 * the DSH shell flips its dark-theme marker.
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
    const VIEW_ID = 'server-monitor'

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

    function MonitorFrame() {
      const [dark, setDark] = React.useState(isDark)

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

      const src = `${FRAME_SRC}?theme=${dark ? 'dark' : 'light'}`
      return h(
        'div',
        {
          style: {
            width: '100%',
            height: '100%',
            minHeight: '420px',
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

    function SidebarTitle() {
      return h('span', { style: { whiteSpace: 'nowrap' } }, '服务器资源')
    }

    function apply(ctx) {
      const slots = ctx.slots
      if (!slots || typeof slots.register !== 'function') return

      // 1) A permanent conversation tab: visible without opening a sidebar.
      try {
        slots.inject('conversation.view', () => slots.register(
          { name: 'conversation.view', id: VIEW_ID, order: 46, label: () => '服务器资源' },
          MonitorFrame,
        ))
      } catch {
        /* older shell without conversation.view: the sidebar below still works */
      }

      // 2) The right sidebar: pane + guide entry.
      try {
        ctx.inject(['sidebarRightTabs'], (injected) => {
          const tabs = injected.sidebarRightTabs
          if (!tabs || typeof tabs.register !== 'function') return undefined
          const disposers = []
          const own = (result) => {
            if (typeof result === 'function') disposers.push(result)
          }
          try {
            own(tabs.register({
              id: VIEW_ID,
              kind: VIEW_ID,
              title: () => '服务器资源',
              guide: [{
                id: VIEW_ID,
                order: 46,
                title: () => '服务器资源',
                description: () => '本机与所有远程服务器的 CPU、内存、磁盘实时占用',
              }],
            }))
            own(injected.slots.inject('sidebar.right.pane.tab', () => injected.slots.register(
              { name: 'sidebar.right.pane.tab', key: VIEW_ID },
              MonitorFrame,
            )))
            own(injected.slots.inject('sidebar.right.pane.tab.title', () => injected.slots.register(
              { name: 'sidebar.right.pane.tab.title', key: VIEW_ID },
              SidebarTitle,
            )))
          } catch {
            for (const dispose of disposers.splice(0)) dispose()
            return undefined
          }
          return () => {
            for (const dispose of disposers.splice(0)) dispose()
          }
        })
      } catch {
        /* sidebarRightTabs is optional */
      }
    }

    return { name: 'dsh-server-monitor', inject: ['slots'], apply }
  },
})
