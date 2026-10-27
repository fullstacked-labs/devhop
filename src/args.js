import { parseTarget } from './port.js';

// Options that apply to a normal run; --help/--version/--doctor pick a mode instead.
const RUN_OPTIONS = ['--json', '--no-qr', '--http2'];
const MODE_OPTIONS = ['--doctor', '--help', '--version'];

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

  // A typo like `--jsno` must not run as if the flag was never passed.
  const unknown = args.find((a) => a.startsWith('-') && !RUN_OPTIONS.includes(a));
  if (unknown) {
    return {
      json,
      error: {
        code: 'INVALID_ARGUMENT',
        message: `Unknown option "${unknown}".`,
        hint: `Options: ${[...RUN_OPTIONS, ...MODE_OPTIONS].join(', ')}\nExample: npx devhop 3000 --json`,
      },
    };
  }

  // Two targets are ambiguous; picking the first would tunnel the wrong server.
  const positional = args.filter((a) => !a.startsWith('-'));
  if (positional.length > 1) {
    return {
      json,
      error: {
        code: 'INVALID_ARGUMENT',
        message: `Expected one target, got ${positional.map((a) => `"${a}"`).join(' and ')}.`,
        hint: 'Example: npx devhop 3000',
      },
    };
  }

  // An explicit argument that fails to parse must error, not fall through to
  // auto-detection — otherwise a typo like `devhop 99999` silently tunnels
  // whatever unrelated server happens to be running.
  const target = positional.length ? parseTarget(positional[0]) : null;
  if (positional.length && !target) {
    return {
      json,
      error: {
        code: 'INVALID_TARGET',
        message: `Invalid target: "${positional[0]}" — expected a port, host:port, or http(s) URL.`,
        hint: 'Examples: npx devhop 3000, npx devhop localhost:5173, npx devhop https://localhost:8443',
      },
    };
  }

  return {
    mode: 'run',
    json,
    qr: !args.includes('--no-qr') && !json,
    protocol: args.includes('--http2') ? 'http2' : undefined,
    target,
  };
}
