import pc from 'picocolors';
import { createMasqueradeProxy } from './proxy.js';
import { detectDevPorts, findFreePort, parseTarget, urlHost } from './port.js';
import { ensureBinary, startTunnel } from './tunnel.js';
import { waitForEdge } from './edge.js';
import { collectDiagnostics, formatDiagnostics } from './doctor.js';
import { printHelp, displayDashboard } from './ui.js';
import { createRequire } from 'node:module';

const { version: VERSION } = createRequire(import.meta.url)('../package.json');

export async function run(args = []) {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp(VERSION);
    return;
  }

  if (args.includes('--version') || args.includes('-v')) {
    console.log(`v${VERSION}`);
    return;
  }

  if (args.includes('--doctor')) {
    const diagnostics = await collectDiagnostics();
    console.log(
      args.includes('--json') ? JSON.stringify({ event: 'doctor', ...diagnostics }) : formatDiagnostics(diagnostics)
    );
    return;
  }
  const isJson = args.includes('--json');
  const emit = (obj) => { if (isJson) console.log(JSON.stringify(obj)); };
  const showQr = !args.includes('--no-qr') && !isJson;
  const protocol = args.includes('--http2') ? 'http2' : undefined;
  // The relay transport is quarantined in experimental/gateway/. Fail loudly
  // instead of letting the URL fall through to target detection.
  if (args.some((a) => a === '--gateway' || a.startsWith('--gateway='))) {
    const message = '--gateway is not available in this build; the relay transport is quarantined under experimental/gateway/.';
    emit({ event: 'error', code: 'GATEWAY_UNAVAILABLE', message });
    console.error(pc.red(`\n${message}`));
    console.error(`Example: ${pc.cyan('npx devhop 3000')}\n`);
    process.exit(1);
  }
  let targetPort = null;
  let targetHost = '127.0.0.1';
  let targetProtocol = 'http:';
  const targetArg = args.find((a) => !a.startsWith('-') && parseTarget(a));
  // An explicit argument that fails to parse must error, not fall through to
  // auto-detection — otherwise a typo like `devhop 99999` silently tunnels
  // whatever unrelated server happens to be running.
  const invalidArg = args.find((a) => !a.startsWith('-') && !parseTarget(a));
  if (invalidArg && !targetArg) {
    emit({ event: 'error', code: 'INVALID_TARGET', message: `Invalid target: "${invalidArg}" — expected a port, host:port, or http(s) URL.` });
    console.error(pc.red(`\nInvalid target: "${invalidArg}" — expected a port, host:port, or http(s) URL.`));
    console.error(`Examples: ${pc.cyan('npx devhop 3000')}, ${pc.cyan('npx devhop localhost:5173')}, ${pc.cyan('npx devhop https://localhost:8443')}\n`);
    process.exit(1);
  }
  if (targetArg) {
    const parsed = parseTarget(targetArg);
    targetPort = parsed.port;
    targetHost = parsed.host;
    targetProtocol = parsed.protocol;
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
      emit({ event: 'error', code: 'NO_DEV_SERVER', message: 'No active dev server detected on standard dev ports. Pass a port, e.g. npx devhop 3000.' });
      console.error(pc.red('\nNo active dev server detected on standard dev ports.'));
      console.error(`Please specify your dev server target explicitly:`);
      console.error(`  ${pc.cyan('npx devhop <port>')}            ${pc.dim('(e.g. npx devhop 3000)')}`);
      console.error(`  ${pc.cyan('npx devhop <host>:<port>')}     ${pc.dim('(e.g. npx devhop localhost:5173)')}`);
      console.error(`  ${pc.cyan('npx devhop <url>')}             ${pc.dim('(e.g. npx devhop http://127.0.0.1:8080)')}\n`);
      process.exit(1);
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
  // Pick an ephemeral local proxy port
  const proxyPort = await findFreePort();

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

  await new Promise((resolve) => server.listen(proxyPort, '127.0.0.1', resolve));

  if (!isJson) {
    console.log(`${pc.dim('  Local masquerade proxy ready on port ' + proxyPort)}`);
    console.log(`${pc.cyan('●')} Connecting secure tunnel to Cloudflare Edge...`);
  }
  let cleanedUp = false;
  let exitingClean = false;
  let tunnelHandle = null;

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (tunnelHandle) tunnelHandle.close();
    try { server.close(); } catch (_) {}
    if (!isJson) console.log(`\n${pc.yellow('✔')} Tunnel disconnected. Cleaned up.\n`);
    if (exitingClean) emit({ event: 'closed' });
  };
  const quit = () => { exitingClean = true; cleanup(); process.exit(0); };
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
