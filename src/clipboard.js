import { spawn } from 'node:child_process';
import fs from 'node:fs';

export function copyToClipboard(text) {
  try {
    if (process.stdout.isTTY) {
      const osc52 = `\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`;
      const sequence = process.env.TMUX ? `\x1bPtmux;${osc52.replaceAll('\x1b', '\x1b\x1b')}\x1b\\` : osc52;
      fs.writeSync(process.stdout.fd, sequence);
    }
  } catch (_) {
    // OSC 52 is best-effort; still try the native clipboard when unavailable.
  }

  try {
    let command = '/bin/sh';
    let script;
    if (process.platform === 'darwin') {
      script = 'printf %s "$DEVHOP_CLIPBOARD" | pbcopy';
    } else if (process.platform === 'win32') {
      command = 'powershell.exe';
      script = '$env:DEVHOP_CLIPBOARD | clip.exe';
    } else if (process.platform === 'linux') {
      if (process.env.WAYLAND_DISPLAY) script = 'printf %s "$DEVHOP_CLIPBOARD" | wl-copy';
      else if (process.env.DISPLAY) script = 'printf %s "$DEVHOP_CLIPBOARD" | xclip -selection clipboard';
    }
    if (!script) return;

    // Fixed scripts keep clipboard contents out of shell syntax while ignoring all stdio.
    const args = process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-Command', script] : ['-c', script];
    const child = spawn(command, args, {
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
      env: { ...process.env, DEVHOP_CLIPBOARD: text }
    });
    child.on('error', () => {}); // Missing clipboard tools must never interrupt the tunnel.
    child.unref();
  } catch (_) {
    // Clipboard access is optional, including on hosts without a desktop session.
  }
}
