import type { PropertyAnalysis } from '../../../../shared/propertyAnalysis'

/**
 * Node/edge view of the scene graph.
 *
 * ── DELIBERATELY NOT A FLOOR PLAN ────────────────────────────────────
 *
 * Rooms are laid out on a circle — an arbitrary arrangement ON PURPOSE.
 * Any position-carrying layout would read as a floor plan and imply we
 * know where rooms sit relative to each other, which we do not: this is a
 * relationship graph inferred from photographs, not a survey. Edge style
 * carries the only spatial claim being made — how confident we are that
 * two rooms connect at all.
 *
 * Lives under Advanced. It is genuinely useful when checking why a
 * transition was planned the way it was, and genuinely noise otherwise.
 */
export function SceneGraph({ analysis }: { analysis: PropertyAnalysis }): React.JSX.Element {
  const size = 220
  const r = 78
  const cx = size / 2
  const cy = size / 2
  const nodes = analysis.rooms.map((room, i) => {
    const angle = (i / Math.max(1, analysis.rooms.length)) * Math.PI * 2 - Math.PI / 2
    return { room, x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r }
  })
  const at = (id: string): { x: number; y: number } | undefined =>
    nodes.find((n) => n.room.id === id)

  return (
    <svg className="scene-graph" viewBox={`0 0 ${size} ${size}`} role="img">
      <title>Room relationship graph</title>
      {analysis.edges.map((edge) => {
        const a = at(edge.fromRoomId)
        const b = at(edge.toRoomId)
        if (!a || !b) return null
        return (
          <line
            key={edge.id}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            className={`scene-edge scene-edge-${edge.confidence}`}
          />
        )
      })}
      {nodes.map((n) => (
        <g key={n.room.id} className="scene-node">
          <circle cx={n.x} cy={n.y} r={5} />
          <text x={n.x} y={n.y - 10} textAnchor="middle">
            {n.room.label}
          </text>
        </g>
      ))}
      {nodes.length === 0 && (
        <text x={cx} y={cy} textAnchor="middle" className="scene-empty">
          No rooms yet
        </text>
      )}
    </svg>
  )
}
