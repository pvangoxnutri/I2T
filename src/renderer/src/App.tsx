import { useState } from 'react'
import { Sidebar, type NavSection } from './components/Sidebar'
import { ProjectsPage } from './components/pages/ProjectsPage'
import { ProjectEditorPage } from './components/pages/ProjectEditorPage'
import { QueuePage } from './components/pages/QueuePage'
import { SettingsPage } from './components/pages/SettingsPage'

/**
 * Top-level navigation. Deliberately plain state (no router dependency):
 * three sections, where Projects owns a sub-view — the editor for one
 * project. Opening a project keeps the Projects section active in the nav.
 */
export default function App(): React.JSX.Element {
  const [section, setSection] = useState<NavSection>('projects')
  const [openProjectId, setOpenProjectId] = useState<string | null>(null)

  const navigate = (next: NavSection): void => {
    setSection(next)
    if (next !== 'projects') setOpenProjectId(null)
  }

  return (
    <div className="app-shell">
      <Sidebar active={section} onNavigate={navigate} />
      <main className="app-main">
        {section === 'projects' &&
          (openProjectId ? (
            <ProjectEditorPage projectId={openProjectId} onBack={() => setOpenProjectId(null)} />
          ) : (
            <ProjectsPage onOpenProject={setOpenProjectId} />
          ))}
        {section === 'queue' && <QueuePage />}
        {section === 'settings' && <SettingsPage />}
      </main>
    </div>
  )
}
