import qrcode from 'qrcode-terminal';
import pc from 'picocolors';
import { urlHost } from './port.js';

export function printHelp(version) {
  console.log(`
${pc.bold(pc.cyan('🐇 devhop'))} ${pc.dim(`v${version}`)}
${pc.dim('Hop local web dev servers onto mobile devices with zero config.')}

${pc.bold('Usage:')}
  ${pc.green('npx devhop [target]')}          Expose dev server by port, host:port, or URL
  ${pc.green('npx devhop')}                   Auto-detect active dev server port
  ${pc.green('npx devhop <target> --no-qr')}  Expose without printing QR code
  ${pc.green('npx devhop <target> --json')}   Output tunnel metadata as JSON (for agents)
  ${pc.green('npx devhop <target> --http2')}  Use HTTP/2 transport (corporate firewall bypass)
  ${pc.green('npx devhop --help')}            Show this help message
  ${pc.green('npx devhop --version')}         Show version
  ${pc.green('npx devhop --doctor')}          Print diagnostics for bug reports

${pc.bold('Examples:')}
  ${pc.dim('$')} npx devhop 3000
  ${pc.dim('$')} npx devhop localhost:5173
  ${pc.dim('$')} npx devhop 127.0.0.1:8080
  ${pc.dim('$')} npx devhop 0.0.0.0:4321
  ${pc.dim('$')} npx devhop http://localhost:5173
`);
}

export function displayDashboard(url, targetPort, targetHost, targetProtocol, showQr, edgeLocation, edgeSlow) {
  const scheme = targetProtocol === 'https:' ? 'https' : 'http';
  // Display-only: newer cloudflared reports IATA + connection index (e.g. ARN02);
  // humans only need the airport code.
  const iata = edgeLocation && /^([A-Z]{3})\d{1,2}$/.test(edgeLocation) ? edgeLocation.slice(0, 3) : edgeLocation;
  console.clear();
  console.log('');
  console.log(pc.bold(pc.bgCyan(pc.black(' 🐇 DEVHOP '))));
  console.log('');
  console.log(`  ${pc.bold('Target:')}       ${pc.green(`${scheme}://${urlHost(targetHost)}:${targetPort}`)}`);
  console.log(`  ${pc.bold('Mobile URL:')}   ${pc.bold(pc.underline(pc.cyan(url)))}`);
  console.log(`  ${pc.yellow('⚠ Public link — anyone with it can open your dev server. Ctrl+C when done.')}`);
  if (edgeSlow) {
    console.log(`  ${pc.yellow("⚠ Cloudflare hasn't answered yet; if the page errors, wait a few seconds and reload.")}`);
  }
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
