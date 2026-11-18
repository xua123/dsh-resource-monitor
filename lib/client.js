/**
 * dsh-resource-monitor — browser half.
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
  id: 'dsh-resource-monitor',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const FRAME_SRC = '/dsh-resource-monitor/'
    const VIEW_ID = 'dsh-resource-monitor'

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
    }

    return { name: 'dsh-resource-monitor', inject: ['slots'], apply }
  },
})
