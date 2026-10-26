import qrcode from 'qrcode-terminal';
import pc from 'picocolors';
import { createMasqueradeProxy } from './proxy.js';
import { detectDevPorts, findFreePort, parseTarget } from './port.js';
import { ensureBinary, startTunnel } from './tunnel.js';
import { startGateway } from './gateway/client.js';
import { createRequire } from 'node:module';

const { version: VERSION } = createRequire(import.meta.url)('../package.json');

export function printHelp() {
  console.log(`
${pc.bold(pc.cyan('🦘 devhop'))} ${pc.dim(`v${VERSION}`)}
${pc.dim('Hop local web dev servers onto mobile devices with zero config.')}

${pc.bold('Usage:')}
  ${pc.green('npx devhop [target]')}          Expose dev server by port, host:port, or URL
  ${pc.green('npx devhop')}                   Auto-detect active dev server port
  ${pc.green('npx devhop <target> --no-qr')}  Expose without printing QR code
  ${pc.green('npx devhop <target> --json')}   Output tunnel metadata as JSON (for agents)
  ${pc.green('npx devhop <target> --http2')}  Use HTTP/2 transport (corporate firewall bypass)
  ${pc.green('npx devhop --help')}            Show this help message
  ${pc.green('npx devhop --version')}         Show version

${pc.bold('Examples:')}
  ${pc.dim('$')} npx devhop 3000
  ${pc.dim('$')} npx devhop localhost:5173
  ${pc.dim('$')} npx devhop 127.0.0.1:8080
  ${pc.dim('$')} npx devhop 0.0.0.0:4321
  ${pc.dim('$')} npx devhop http://localhost:5173
`);
}


export async function run(args = []) {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  if (args.includes('--version') || args.includes('-v')) {
    console.log(`v${VERSION}`);
    return;
  }
  const isJson = args.includes('--json');
  const showQr = !args.includes('--no-qr') && !isJson;
  const protocol = args.includes('--http2') ? 'http2' : undefined;
  const gatewayIdx = args.findIndex((a) => a === '--gateway' || a.startsWith('--gateway='));
  let gatewayUrl = null;
  if (gatewayIdx !== -1) {
    gatewayUrl = args[gatewayIdx].startsWith('--gateway=') ? args[gatewayIdx].slice(10) : args[gatewayIdx + 1];
    // ws:// is for local/test relays, wss:// for real ones.
    if (!gatewayUrl || gatewayUrl.startsWith('-') || !/^wss?:\/\//.test(gatewayUrl)) {
      console.error(pc.red(`\nInvalid gateway URL: "${gatewayUrl}" — expected ws://host:port or wss://host.`));
      console.error(`Example: ${pc.cyan('devhop --gateway wss://devhop.se')}\n`);
      process.exit(1);
    }
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
      console.error(pc.red('\nNo active dev server detected on standard dev ports.'));
      console.error(`Please specify your dev server target explicitly:`);
      console.error(`  ${pc.cyan('npx devhop <port>')}            ${pc.dim('(e.g. npx devhop 3000)')}`);
      console.error(`  ${pc.cyan('npx devhop <host>:<port>')}     ${pc.dim('(e.g. npx devhop localhost:5173)')}`);
      console.error(`  ${pc.cyan('npx devhop <url>')}             ${pc.dim('(e.g. npx devhop http://127.0.0.1:8080)')}\n`);
      process.exit(1);
    }
  }

  if (!isJson) console.log(`\n${pc.cyan('●')} Initializing ${pc.bold('devhop')} for port ${pc.bold(targetPort)}...`);

  // Gateway mode doesn't use cloudflared, so skip the download.
  const binPath = gatewayUrl
    ? null
    : await ensureBinary((msg) => {
        if (!isJson) console.log(`${pc.dim('  ' + msg)}`);
      });
  // Pick an ephemeral local proxy port
  const proxyPort = await findFreePort();

  let publicUrl = null;
  let edgeLocation = null;

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
  let tunnelHandle = null;

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (tunnelHandle) tunnelHandle.close();
    try { server.close(); } catch (_) {}
    if (!isJson) console.log(`\n${pc.yellow('✔')} Tunnel disconnected. Cleaned up.\n`);
  };
  const quit = () => { cleanup(); process.exit(0); };
  const renderDashboard = () => {
    displayDashboard(publicUrl, targetPort, targetHost, targetProtocol, showQr, edgeLocation);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
    process.on(sig, quit);
  }
  process.on('uncaughtException', (err) => {
    cleanup();
    console.error(pc.red(`\nUncaught error: ${err.message}`));
    process.exit(1);
  });
  process.on('exit', cleanup);
  const callbacks = {
    onUrl: (url) => {
      publicUrl = url;
      if (isJson) {
        console.log(JSON.stringify({ url, target: `${targetProtocol === 'https:' ? 'https' : 'http'}://${targetHost}:${targetPort}`, port: targetPort, host: targetHost, protocol: targetProtocol }));
      } else {
        renderDashboard();
      }
    },
    onRetry: () => {
      if (!isJson) console.log(pc.yellow('↻ Tunnel dropped — reconnecting...'));
    },
    onError: (err) => {
      console.error(pc.red(`\nTunnel failed: ${err.message}`));
      cleanup();
      process.exit(1);
    },
    onClose: () => {
      if (!cleanedUp) {
        cleanup();
        process.exit(1);
      }
    }
  };
  if (gatewayUrl) {
    tunnelHandle = startGateway({
      localPort: proxyPort,
      gatewayUrl,
      token: process.env.DEVHOP_GATEWAY_TOKEN || '',
      ...callbacks
    });
  } else {
    tunnelHandle = startTunnel({
      localPort: proxyPort,
      binPath,
      protocol,
      onLocation: (loc) => {
        if (loc !== edgeLocation) {
          edgeLocation = loc;
          if (publicUrl && !isJson) renderDashboard();
        }
      },
      onRetry: () => {
        if (!isJson) console.log(pc.yellow('↻ Quick-tunnel setup failed — retrying once in 2s...'));
      },
      ...callbacks,
      onError: (err) => {
        console.error(pc.red(`\nFailed to start cloudflared: ${err.message}`));
        cleanup();
        process.exit(1);
      },
      onClose: (code, details) => {
        if (!cleanedUp) {
          const isError = (code !== 0 && code !== null) || (!details?.urlFound);
          if (isError) {
            const exitDesc = code !== null ? `code ${code}` : `signal ${details?.signal || 'UNKNOWN'}`;
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
}

function displayDashboard(url, targetPort, targetHost, targetProtocol, showQr, edgeLocation) {
  const scheme = targetProtocol === 'https:' ? 'https' : 'http';
  // Display-only: newer cloudflared reports IATA + connection index (e.g. ARN02);
  // humans only need the airport code.
  const iata = edgeLocation && /^([A-Z]{3})\d{1,2}$/.test(edgeLocation) ? edgeLocation.slice(0, 3) : edgeLocation;
  console.clear();
  console.log('');
  console.log(pc.bold(pc.bgCyan(pc.black(' 🦘 DEVHOP '))));
  console.log('');
  console.log(`  ${pc.bold('Target:')}       ${pc.green(`${scheme}://${targetHost}:${targetPort}`)}`);
  console.log(`  ${pc.bold('Mobile URL:')}   ${pc.bold(pc.underline(pc.cyan(url)))}`);
  console.log(`  ${pc.yellow('⚠ Public link — anyone with it can open your dev server. Ctrl+C when done.')}`);
  console.log('');
  if (edgeLocation) {
    console.log(`  ${pc.green('✔')} Connected to Cloudflare Edge [${iata}]`);
    console.log('');
  }
  if (showQr) {
    console.log(pc.dim('  Scan with your iPhone or Android camera:'));
    console.log('');
    qrcode.generate(url, { small: true }, (qr) => {
      // Explicit fg/bg colors: qrcode-terminal emits bare half-block chars, so on
      // dark themes the modules inherit a loud default color. ▀/▄/█ get white ink,
      // spaces (dark modules) get a black background — theme-independent, classic
      // white-slab QR, and stripping the ANSI leaves the characters identical.
      const styled = qr.split('\n').map((line) =>
        '  ' + pc.bgBlack(pc.white(line))
      ).join('\n');
      console.log(styled);
    });
  }

  console.log('');
  console.log(pc.dim('  Press ') + pc.bold('Ctrl+C') + pc.dim(' to stop the tunnel and disconnect.'));
  console.log('');
}
