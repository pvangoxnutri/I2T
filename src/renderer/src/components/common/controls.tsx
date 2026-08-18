import { useId, type ReactNode } from 'react'

/** Shared form primitives so every panel (branding, settings) stays visually
 * identical without repeating markup. */

export function Field({
  label,
  children,
  hint
}: {
  label: string
  children: ReactNode
  hint?: string
}): React.JSX.Element {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  )
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>): React.JSX.Element {
  return <input {...props} className={`input ${props.className ?? ''}`} />
}

export function SelectInput(
  props: React.SelectHTMLAttributes<HTMLSelectElement>
): React.JSX.Element {
  return <select {...props} className={`input select ${props.className ?? ''}`} />
}

export function SliderRow({
  label,
  value,
  min,
  max,
  step = 1,
  unit = '%',
  onChange
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  onChange: (value: number) => void
}): React.JSX.Element {
  const id = useId()
  return (
    <div className="slider-row">
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="slider-value">
        {value}
        {unit}
      </span>
    </div>
  )
}

export function Toggle({
  label,
  checked,
  onChange
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`toggle${checked ? ' is-on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-track">
        <span className="toggle-thumb" />
      </span>
      <span className="toggle-label">{label}</span>
    </button>
  )
}

export function SectionCard({
  title,
  subtitle,
  children,
  actions
}: {
  title: string
  subtitle?: string
  children: ReactNode
  actions?: ReactNode
}): React.JSX.Element {
  return (
    <section className="section-card">
      <header className="section-card-head">
        <div>
          <h3 className="section-card-title">{title}</h3>
          {subtitle ? <p className="section-card-subtitle">{subtitle}</p> : null}
        </div>
        {actions}
      </header>
      <div className="section-card-body">{children}</div>
    </section>
  )
}

/** Small file picker that reads the chosen image as a data URL. */
export function ImagePickerButton({
  label,
  onPick
}: {
  label: string
  onPick: (dataUrl: string, fileName: string) => void
}): React.JSX.Element {
  const id = useId()
  return (
    <>
      <input
        id={id}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (!file) return
          const reader = new FileReader()
          reader.onload = () => onPick(String(reader.result), file.name)
          reader.readAsDataURL(file)
          e.target.value = ''
        }}
      />
      <label htmlFor={id} className="btn btn-ghost">
        {label}
      </label>
    </>
  )
}
