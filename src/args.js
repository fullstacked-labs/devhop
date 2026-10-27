import { parseTarget } from './port.js';

const GATEWAY_MESSAGE = '--gateway is not available in this build; the relay transport is quarantined under experimental/gateway/.';

/**
 * Turns argv into a mode plus options, or one structured error. `json` is
 * always present so a caller can still report the error as a JSON event.
 *
 * @param {string[]} args
 * @returns {{ mode: 'help' | 'version' | 'doctor', json: boolean }
 *   | { mode: 'run', json: boolean, qr: boolean, protocol: 'http2' | undefined, target: { port: number, host: string, protocol: string } | null }
 *   | { json: boolean, error: { code: string, message: string, hint?: string } }}
 */
export function parseArgs(args) {
  const json = args.includes('--json');
  if (args.includes('--help') || args.includes('-h')) return { mode: 'help', json };
  if (args.includes('--version') || args.includes('-v')) return { mode: 'version', json };
  if (args.includes('--doctor')) return { mode: 'doctor', json };

  // The relay transport is quarantined in experimental/gateway/. Fail loudly
  // instead of letting the URL fall through to target detection.
  if (args.some((a) => a === '--gateway' || a.startsWith('--gateway='))) {
    return { json, error: { code: 'GATEWAY_UNAVAILABLE', message: GATEWAY_MESSAGE, hint: 'Example: npx devhop 3000' } };
  }

  const positional = args.filter((a) => !a.startsWith('-'));
  const targetArg = positional.find((a) => parseTarget(a));
  // An explicit argument that fails to parse must error, not fall through to
  // auto-detection — otherwise a typo like `devhop 99999` silently tunnels
  // whatever unrelated server happens to be running.
  const invalidArg = positional.find((a) => !parseTarget(a));
  if (invalidArg && !targetArg) {
    return {
      json,
      error: {
        code: 'INVALID_TARGET',
        message: `Invalid target: "${invalidArg}" — expected a port, host:port, or http(s) URL.`,
        hint: 'Examples: npx devhop 3000, npx devhop localhost:5173, npx devhop https://localhost:8443',
      },
    };
  }

  return {
    mode: 'run',
    json,
    qr: !args.includes('--no-qr') && !json,
    protocol: args.includes('--http2') ? 'http2' : undefined,
    target: targetArg ? parseTarget(targetArg) : null,
  };
}
