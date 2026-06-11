// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, it, expect } from 'vitest';
import { browserOpenCommand } from './open-browser.ts';

describe('browserOpenCommand', () => {
  const url = 'http://localhost:3000';

  it('uses `open` on macOS', () => {
    expect(browserOpenCommand(url, 'darwin')).toEqual({
      command: 'open',
      args: [url],
    });
  });

  it('uses `cmd /c start` on Windows', () => {
    expect(browserOpenCommand(url, 'win32')).toEqual({
      command: 'cmd',
      args: ['/c', 'start', '""', url],
    });
  });

  it('uses `xdg-open` on Linux/other', () => {
    expect(browserOpenCommand(url, 'linux')).toEqual({
      command: 'xdg-open',
      args: [url],
    });
  });
});
