import { useEffect, useState } from 'react'
import type { Project, CustomerDetails } from '../../types'

/**
 * Customer Details — organization info for project tracking.
 *
 * Shows as a right-side drawer, independent of editor selection.
 * Editable fields persist immediately to the project.
 */
export function CustomerDetailsDrawer({
  project,
  open,
  onClose
}: {
  project: Project
  open: boolean
  onClose: () => void
}): React.JSX.Element {
  const [details, setDetails] = useState<CustomerDetails>(project.customer ?? {})

  useEffect(() => {
    setDetails(project.customer ?? {})
  }, [project.customer])

  const saveField = (field: keyof CustomerDetails, value: string | undefined): void => {
    const updated = { ...details, [field]: value || undefined }
    setDetails(updated)
    // Save to project
    window.f2f.projects.save({
      ...project,
      customer: Object.keys(updated).length > 0 ? updated : undefined
    })
  }

  if (!open) return <></>

  return (
    <div className="catalogue-overlay" onClick={onClose}>
      <div className="catalogue-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="catalogue-header">
          <h2>Customer Details</h2>
          <button type="button" className="catalogue-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="catalogue-body">
          <div className="customer-details-form">
            <div className="form-group">
              <label htmlFor="cust-name">Organization Name</label>
              <input
                id="cust-name"
                type="text"
                value={details.name ?? ''}
                onChange={(e) => saveField('name', e.target.value)}
                placeholder="e.g., Acme Inc."
              />
            </div>

            <div className="form-group">
              <label htmlFor="cust-contact">Contact Person</label>
              <input
                id="cust-contact"
                type="text"
                value={details.contactPerson ?? ''}
                onChange={(e) => saveField('contactPerson', e.target.value)}
                placeholder="e.g., Jane Doe"
              />
            </div>

            <div className="form-group">
              <label htmlFor="cust-email">Email</label>
              <input
                id="cust-email"
                type="email"
                value={details.email ?? ''}
                onChange={(e) => saveField('email', e.target.value)}
                placeholder="jane@example.com"
              />
            </div>

            <div className="form-group">
              <label htmlFor="cust-phone">Phone</label>
              <input
                id="cust-phone"
                type="tel"
                value={details.phone ?? ''}
                onChange={(e) => saveField('phone', e.target.value)}
                placeholder="+1 (555) 123-4567"
              />
            </div>

            <div className="form-group">
              <label htmlFor="cust-notes">Notes</label>
              <textarea
                id="cust-notes"
                value={details.notes ?? ''}
                onChange={(e) => saveField('notes', e.target.value)}
                placeholder="Any additional notes..."
                rows={4}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
