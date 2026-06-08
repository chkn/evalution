import { describe, it, expect } from 'vitest';
import { resolveTerminalCommand, shellCommandArgs } from './terminal.ts';

describe('resolveTerminalCommand', () => {
  it('maps an install_package step to its npm command', () => {
    expect(resolveTerminalCommand('vercel-ai-sdk', 'install-ai')).toBe('npm i ai');
  });

  it('returns null for a create_config step (it writes a file, not a command)', () => {
    expect(resolveTerminalCommand('vercel-ai-sdk', 'create-config')).toBeNull();
  });

  it('returns null for unknown task or step ids', () => {
    expect(resolveTerminalCommand('nope', 'install-ai')).toBeNull();
    expect(resolveTerminalCommand('vercel-ai-sdk', 'nope')).toBeNull();
  });
});

describe('shellCommandArgs', () => {
  it('passes the command through the shell via -c, whatever the shell', () => {
    const args = shellCommandArgs('npm i ai');
    // The last two args are always `-c <command>`; any earlier args are the
    // shell-specific flags that skip startup files.
    expect(args.slice(-2)).toEqual(['-c', 'npm i ai']);
  });
});
