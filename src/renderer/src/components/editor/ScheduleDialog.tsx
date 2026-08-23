import { useState } from 'react'

/**
 * Date + time picker for deferring production work. Local machine time
 * throughout — no timezone conversion, no cloud scheduler.
 */
export function ScheduleDialog({
  onCancel,
  onConfirm
}: {
  onCancel: () => void
  onConfirm: (epochMs: number) => void
}): React.JSX.Element {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const [date, setDate] = useState(
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  )
  const [time, setTime] = useState(`${pad(now.getHours())}:${pad(Math.min(59, now.getMinutes() + 5))}`)
  const [error, setError] = useState<string | null>(null)

  const confirm = (): void => {
    // `new Date("YYYY-MM-DDTHH:mm")` parses as LOCAL time — exactly what we
    // want for a machine-local scheduler.
    const when = new Date(`${date}T${time}`)
    if (Number.isNaN(when.getTime())) {
      setError('Pick a valid date and time.')
      return
    }
    if (when.getTime() <= Date.now()) {
      setError('That time has already passed — it would run immediately.')
      return
    }
    onConfirm(when.getTime())
  }

  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div className="dialog-card" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog-title">Schedule production</h3>
        <p className="dialog-body">
          The job waits in the queue and becomes eligible at this local time. If the app is closed
          then, it runs at the next launch.
        </p>
        <div className="field-row">
          <label className="field">
            <span className="field-label">Date</span>
            <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">Time</span>
            <input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </label>
        </div>
        {error && <p className="export-missing">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost btn-tiny" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary btn-tiny" onClick={confirm}>
            Schedule
          </button>
        </div>
      </div>
    </div>
  )
}
