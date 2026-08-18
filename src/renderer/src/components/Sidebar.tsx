export type NavSection = 'projects' | 'queue' | 'settings'

const NAV_ITEMS: { key: NavSection; label: string; hint: string; icon: React.JSX.Element }[] = [
  {
    key: 'projects',
    label: 'Projects',
    hint: 'Property videos',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="M3 15l5-5 4 4 3-3 6 6" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="9" cy="9" r="0.5" fill="currentColor" />
      </svg>
    )
  },
  {
    key: 'queue',
    label: 'Queue',
    hint: 'Render jobs',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M4 6h16M4 12h10M4 18h7" strokeLinecap="round" />
        <path d="M17 15l3 3-3 3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  },
  {
    key: 'settings',
    label: 'Settings',
    hint: 'Providers & defaults',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.6 1.6 0 0 0 .32 1.77l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.6 1.6 0 0 0-1.77-.32 1.6 1.6 0 0 0-.97 1.47V21a2 2 0 1 1-4 0v-.09a1.6 1.6 0 0 0-1.05-1.47 1.6 1.6 0 0 0-1.77.32l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.6 1.6 0 0 0 4.6 15a1.6 1.6 0 0 0-1.47-.97H3a2 2 0 1 1 0-4h.09A1.6 1.6 0 0 0 4.56 9a1.6 1.6 0 0 0-.32-1.77l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.6 1.6 0 0 0 8.84 4.72 1.6 1.6 0 0 0 9.81 3.25V3.16a2 2 0 1 1 4 0v.09c0 .64.38 1.22.97 1.47.6.25 1.28.12 1.77-.32l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.6 1.6 0 0 0 19.06 9c.25.6.83.98 1.47.98H20.6a2 2 0 1 1 0 4h-.09A1.6 1.6 0 0 0 19.4 15z" />
      </svg>
    )
  }
]

export function Sidebar({
  active,
  onNavigate
}: {
  active: NavSection
  onNavigate: (section: NavSection) => void
}): React.JSX.Element {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="sidebar-brand-mark" aria-hidden>
          <span>F</span>
          <span className="sidebar-brand-arrow">→</span>
          <span>F</span>
        </div>
        <div className="sidebar-brand-text">
          <span className="sidebar-brand-name">FrameToFrame</span>
          <span className="sidebar-brand-tag">Property Video Studio</span>
        </div>
      </div>

      <nav className="sidebar-nav">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`sidebar-item${active === item.key ? ' is-active' : ''}`}
            onClick={() => onNavigate(item.key)}
          >
            <span className="sidebar-item-icon">{item.icon}</span>
            <span className="sidebar-item-text">
              <span className="sidebar-item-label">{item.label}</span>
              <span className="sidebar-item-hint">{item.hint}</span>
            </span>
          </button>
        ))}
      </nav>

      <div className="sidebar-footer">
        <span className="sidebar-version">v0.1.0 · local preview</span>
      </div>
    </aside>
  )
}
