interface TerminalViewProps {
  /** The command queued up in this terminal, shown ready to run. */
  command: string;
}

/**
 * Placeholder terminal pane: shows the queued command and prompts the user to
 * run it. The live interactive terminal (server-side PTY streamed over a
 * WebSocket, with keystrokes sent back) lands in a later pass; this scaffolds
 * the tab plumbing in the meantime.
 */
export function TerminalView({ command }: TerminalViewProps) {
  return (
    <div className="terminal-view">
      <pre className="terminal-view-line"><span className="terminal-view-prompt">$ </span>{command}</pre>
      <p className="terminal-view-hint">Press <kbd>Return</kbd> to run (live terminal coming soon).</p>
    </div>
  );
}
