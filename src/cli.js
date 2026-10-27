import pc from 'picocolors';
import { createMasqueradeProxy } from './proxy.js';
import { detectDevPorts, urlHost } from './port.js';
import { ensureBinary, startTunnel } from './tunnel.js';
import { waitForEdge } from './edge.js';
import { collectDiagnostics, formatDiagnostics } from './doctor.js';
import { parseArgs } from './args.js';
import { printHelp, displayDashboard } from './ui.js';
import { createRequire } from 'node:module';

const { version: VERSION } = createRequire(import.meta.url)('../package.json');

// Prints the error (as a JSON event too under --json) and exits.
function fail({ json, code, message, hint }) {
  if (json) console.log(JSON.stringify({ event: 'error', code, message }));
  console.error(pc.red(`\n${message}`));
  if (hint) console.error(`${hint}\n`);
  process.exit(1);
}

export async function run(args = []) {
  const parsed = parseArgs(args);
  if (parsed.error) fail({ json: parsed.json, ...parsed.error });

  if (parsed.mode === 'help') {
    printHelp(VERSION);
    return;
  }

  if (parsed.mode === 'version') {
    console.log(`v${VERSION}`);
    return;
  }

  if (parsed.mode === 'doctor') {
    const diagnostics = await collectDiagnostics();
    console.log(
      parsed.json ? JSON.stringify({ event: 'doctor', ...diagnostics }) : formatDiagnostics(diagnostics)
    );
    return;
  }

  const isJson = parsed.json;
  const emit = (obj) => { if (isJson) console.log(JSON.stringify(obj)); };
  const showQr = parsed.qr;
  const protocol = parsed.protocol;
  let targetPort = null;
  let targetHost = '127.0.0.1';
  let targetProtocol = 'http:';
  if (parsed.target) {
    targetPort = parsed.target.port;
    targetHost = parsed.target.host;
    targetProtocol = parsed.target.protocol;
  } else {
    // Port auto-detection
    if (!isJson) console.log(`\n${pc.cyan('●')} Scanning for active dev servers...`);
    const active = await detectDevPorts();
    if (active.length === 1) {
      targetPort = active[0];
      if (!isJson) console.log(`${pc.green('✔')} Auto-detected dev server running on port ${pc.bold(targetPort)}`);
    } else if (active.length > 1) {
      targetPort = active[0];
      if (!isJson) {
        console.log(
          `${pc.yellow('!')} Found multiple active ports (${active.join(', ')}). Using ${pc.bold(targetPort)}.`
        );
        console.log(`${pc.dim('  Tip: Specify explicitly with: npx devhop <port>')}`);
      }
    } else {
      fail({
        json: isJson,
        code: 'NO_DEV_SERVER',
        message: 'No active dev server detected on standard dev ports. Pass a port, e.g. npx devhop 3000.',
        hint: [
          'Target forms:',
          '  npx devhop <port>            (e.g. npx devhop 3000)',
          '  npx devhop <host>:<port>     (e.g. npx devhop localhost:5173)',
          '  npx devhop <url>             (e.g. npx devhop http://127.0.0.1:8080)',
        ].join('\n'),
      });
    }
  }

  if (!isJson) console.log(`\n${pc.cyan('●')} Initializing ${pc.bold('devhop')} for port ${pc.bold(targetPort)}...`);

  let binPath;
  try {
    binPath = await ensureBinary((msg) => {
      if (!isJson) console.log(`${pc.dim('  ' + msg)}`);
    });
  } catch (err) {
    emit({ event: 'error', code: 'CLOUDFLARED_INSTALL_FAILED', message: err.message });
    if (!isJson) throw err;
    process.exit(1);
  }

  let publicUrl = null;
  let edgeLocation = null;
  let edgeSlow = false;
  let announced = false;

  // Create reverse proxy with header masquerade & response rewriting
  const { server } = createMasqueradeProxy({
    targetPort,
    targetHost,
    targetProtocol,
    getPublicUrl: () => publicUrl
  });

  // Let the OS pick the port: probing for a free one first leaves a window for
  // another process to take it before the proxy binds.
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  } catch (err) {
    fail({
      json: isJson,
      code: 'PROXY_START_FAILED',
      message: `Could not start the local proxy: ${err.message}`,
      hint: 'Check for a process limit or a firewall rule blocking local sockets, then run devhop again.',
    });
  }
  const proxyPort = server.address().port;

  if (!isJson) {
    console.log(`${pc.dim('  Local masquerade proxy ready on port ' + proxyPort)}`);
    console.log(`${pc.cyan('●')} Connecting secure tunnel to Cloudflare Edge...`);
  }
  let cleanedUp = false;
  let tunnelHandle = null;
  let tunnelClosed = Promise.resolve();

  const cleanup = () => {
    if (cleanedUp) return tunnelClosed;
    cleanedUp = true;
    if (tunnelHandle) tunnelClosed = tunnelHandle.close();
    try { server.close(); } catch (_) {}
    if (!isJson) console.log(`\n${pc.yellow('✔')} Tunnel disconnected. Cleaned up.\n`);
    return tunnelClosed;
  };
  // Exit only after cloudflared is gone: process.exit would cancel the SIGKILL
  // fallback, and a cloudflared that ignores SIGTERM would be left running.
  const quit = async () => {
    await cleanup();
    emit({ event: 'closed' });
    process.exit(0);
  };
  const renderDashboard = () => {
    displayDashboard(publicUrl, targetPort, targetHost, targetProtocol, showQr, edgeLocation, edgeSlow);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
    process.on(sig, quit);
  }
  process.on('uncaughtException', (err) => {
    cleanup();
    emit({ event: 'error', code: 'UNCAUGHT', message: err.message });
    console.error(pc.red(`\nUncaught error: ${err.message}`));
    process.exit(1);
  });
  process.on('exit', cleanup);
  const announce = (url, edgeReady) => {
    announced = true;
    if (isJson) {
      emit({ event: 'ready', url, inspectUrl: `${url}/__devhop/inspect`, target: `${targetProtocol === 'https:' ? 'https' : 'http'}://${urlHost(targetHost)}:${targetPort}`, port: targetPort, host: targetHost, protocol: targetProtocol, ...(edgeReady !== undefined && { edgeReady }) });
    } else {
      renderDashboard();
    }
  };
  tunnelHandle = startTunnel({
    localPort: proxyPort,
    binPath,
    protocol,
    onLocation: (loc) => {
      if (loc !== edgeLocation) {
        edgeLocation = loc;
        if (announced && !isJson) renderDashboard();
      }
    },
    // A fresh quick tunnel answers 530 for a few seconds after cloudflared
    // prints its URL; announcing earlier sends the first scan to an error page.
    onUrl: async (url) => {
      publicUrl = url;
      if (!isJson) console.log(pc.dim('  Waiting for Cloudflare edge...'));
      const edge = await waitForEdge(url);
      if (cleanedUp) return;
      edgeSlow = !edge.ready;
      announce(url, edge.ready);
    },
    onRetry: (attempt) => {
      emit({ event: 'reconnecting', attempt });
      if (!isJson) console.log(pc.yellow('↻ Quick-tunnel setup failed — retrying once in 2s...'));
    },
    onError: (err) => {
      emit({ event: 'error', code: 'TUNNEL_START_FAILED', message: err.message });
      console.error(pc.red(`\nFailed to start cloudflared: ${err.message}`));
      cleanup();
      process.exit(1);
    },
    onClose: (code, details) => {
      if (!cleanedUp) {
        const isError = (code !== 0 && code !== null) || (!details?.urlFound);
        if (isError) {
          const exitDesc = code !== null ? `code ${code}` : `signal ${details?.signal || 'UNKNOWN'}`;
          emit({ event: 'error', code: 'TUNNEL_EXITED', message: `cloudflared exited unexpectedly (${exitDesc})` });
          console.error(pc.red(`\ncloudflared exited unexpectedly (${exitDesc}):`));
          if (details?.recentOutput) {
            console.error(pc.dim(details.recentOutput.split('\n').map((l) => '  > ' + l).join('\n')));
          }
        }
        cleanup();
        process.exit(typeof code === 'number' && code !== 0 ? code : (isError ? 1 : 0));
      }
    }
  });
}
