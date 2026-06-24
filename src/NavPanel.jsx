export default function NavPanel({ display, muted, onStop, onToggleMute }) {
  const { icon, instruction, distance, next, progress } = display;

  return (
    <div className="nav-panel">
      <div className="nav-track">
        <div className="nav-fill" style={{ width: `${Math.min(100, progress * 100).toFixed(1)}%` }} />
      </div>

      <div className="nav-main">
        <span className="nav-icon">{icon}</span>
        <div>
          <div className="nav-instruction">{instruction}</div>
          <div className="nav-distance">{distance}</div>
        </div>
      </div>

      <div className="nav-footer">
        <span className="nav-next">{next}</span>
        <div className="nav-controls">
          <button onClick={onToggleMute}>{muted ? '🔇' : '🔊'}</button>
          <button className="nav-stop" onClick={onStop}>■ Stop</button>
        </div>
      </div>
    </div>
  );
}
