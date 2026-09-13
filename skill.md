# DevHop Skill for AI Coding Agents

Use this skill when a user wants to:
1. **Test a local website or web app on their phone** (iPhone Safari, Android Chrome).
2. **Test features that require HTTPS on mobile**:
   - Microphone, voice dictation, and speech-to-text (`navigator.mediaDevices.getUserMedia`)
   - Camera access and barcode/photo capture
   - WebCrypto, Passkeys, and FaceID/TouchID login
   - "Add to Home Screen" PWA testing
3. **Fix framework mobile errors**:
   - Next.js "Blocked cross-origin request" / `allowedDevOrigins`
   - Next.js Server Actions CSRF origin mismatches
   - Vite "Blocked request: host not allowed"
4. **Test apps running in Docker / WSL2**:
   - Servers bound to `0.0.0.0` or container IPs

## Commands
```bash
# Auto-detect active dev server port (Next.js, Vite, Astro, Nuxt, etc.)
npx devhop

# Specify port explicitly
npx devhop 3000

# Tolerant target inputs (agents can pass full URLs or hosts from terminal output)
npx devhop http://localhost:5173
npx devhop localhost:3000
npx devhop 0.0.0.0:4321


# Upstream HTTPS (self-signed loopback certificates are accepted)
npx devhop https://localhost:8443
# Targets accept bare ports, host:port, and http(s):// URLs; bare 443 implies HTTPS.
# Loopback self-signed certificates are accepted; a wrong scheme returns 502 with a retry hint.
# Output clean JSON for automation (`url`, `target`, `port`, `host`, `protocol`)
npx devhop 3000 --json
# Copy the tunnel URL automatically once it is ready (interactive terminals)
npx devhop 3000 --copy

# Run without printing terminal QR code (useful for headless / CI logs)
npx devhop --no-qr

# Corporate firewall bypass: route tunnel over HTTP/2 (TCP 443) when UDP/QUIC is blocked
npx devhop 3000 --http2
```

### Interactive shortcuts

In an interactive terminal (not CI, piped stdin, or `--json`):

| Input | Action |
| --- | --- |
| `c` + Enter | Copy the tunnel URL |
| `o` + Enter | Open the tunnel URL in a browser |
| `q` + Enter | Quit and disconnect |
| `h` + Enter | Show shortcut help |

`--copy` opts into copying when the tunnel URL is ready; otherwise the clipboard is untouched until `c`.

## How It Works
1. **Instant trusted HTTPS**: Creates a temporary, trusted HTTPS link via Cloudflare's edge with zero account setup.
2. **Framework friendly**: Relabels incoming requests in-process so Next.js and Vite treat the phone as a local browser tab running on loopback, completely avoiding cross-origin blocks.
3. **Live updates on save**: Preserves the live WebSocket connection so your phone updates automatically as you edit code.
4. **Real HTTPS padlock**: Mobile Safari and Chrome grant full access to microphone, camera, and WebCrypto without certificate warnings.
5. **Survives server restarts**: Recovers from `ECONNREFUSED` during Vite or Next.js rebuilds without dropping the tunnel.
6. **Mobile inspector**: Open `https://<tunnel>/__devhop/inspect` for an app preview iframe, a one-tap Eruda bookmarklet, and Vite/Next.js bundler recipes; the app HTML stays untouched.

## Instructions for AI Agents
- When the user asks to preview their app on a phone or test microphone/camera: invoke `npx devhop` (or pass the port/URL if known).
- Parse the output for the public `https://*.trycloudflare.com` URL and QR code, then present them cleanly to the user.
- **Speak in human terms**: Do not burden the user with jargon like "HMR" or "header masquerading". Say:
  > *"Here is your mobile preview link. Scan the QR code with your phone camera to open it. Live updates on save, microphone, and camera access will work automatically."*
- To shut down: send `SIGINT` (Ctrl+C). DevHop guarantees clean child process termination with zero orphan process leaks.
