import { spawn } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import https from "node:https"
import path from "node:path"
import tls from "node:tls"
import { fileURLToPath } from "node:url"

// gh's native Unix-socket transport sends HTTP without consulting macOS's
// system-only CA store. This bridge runs INSIDE the sandbox with only the
// masked token, and still uses SRT's authenticated, TLS-verifying proxy.
export function createGitHubBridge(proxyText) {
  const proxy = new URL(proxyText)
  if (
    proxy.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(proxy.hostname) ||
    !proxy.username ||
    !proxy.password
  ) {
    throw new Error("Authenticated local HTTP proxy required")
  }
  const agent = new https.Agent({ keepAlive: false })
  agent.createConnection = (options, callback) => {
    const connect = http.request({
      hostname: proxy.hostname.replace(/^\[|\]$/g, ""),
      port: proxy.port || 80,
      method: "CONNECT",
      path: `${options.host}:443`,
      headers: {
        "Proxy-Authorization": `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`,
      },
    })
    connect.setTimeout(30000, () => connect.destroy(new Error("GitHub proxy timed out")))
    connect.once("error", callback)
    connect.once("connect", (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy()
        callback(new Error("GitHub proxy refused connection"))
        return
      }
      if (head.length) socket.unshift(head)
      callback(null, tls.connect({ socket, servername: options.host }))
    })
    connect.end()
  }
  const server = http.createServer((request, response) => {
    const host = request.headers.host
    if (
      !["api.github.com", "uploads.github.com"].includes(host) ||
      !request.url.startsWith("/") ||
      request.url.startsWith("//")
    ) {
      response.writeHead(403).end("GitHub API host required")
      request.resume()
      return
    }
    const upstream = https.request(
      {
        hostname: host,
        port: 443,
        path: request.url,
        method: request.method,
        headers: request.headers,
        agent,
      },
      (result) => {
        response.writeHead(result.statusCode, result.headers)
        result.pipe(response)
      },
    )
    upstream.setTimeout(120000, () => upstream.destroy(new Error("GitHub request timed out")))
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502).end("GitHub request failed")
      else response.destroy()
    })
    response.on("close", () => upstream.destroy())
    request.on("error", () => upstream.destroy())
    request.pipe(upstream)
  })
  server.on("close", () => agent.destroy())
  return server
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [socketPath, shell, command] = process.argv.slice(2)
  const server = createGitHubBridge(process.env.HTTPS_PROXY)
  const configDirectory = process.env.GH_CONFIG_DIR
  fs.mkdirSync(configDirectory, { mode: 0o700 })
  try {
    fs.writeFileSync(
      path.join(configDirectory, "config.yml"),
      `http_unix_socket: ${JSON.stringify(socketPath)}\n`,
      { mode: 0o600, flag: "wx" },
    )
    await new Promise((resolve, reject) => {
      server.once("error", reject)
      server.listen(socketPath, resolve)
    })
    fs.chmodSync(socketPath, 0o600)
    const child = spawn(shell, ["-c", command], { stdio: "inherit" })
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
      process.on(signal, () => child.kill(signal))
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code, signal) =>
        resolve(code ?? { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[signal] ?? 1),
      )
    })
  } finally {
    server.closeAllConnections()
    server.close()
    fs.rmSync(socketPath, { force: true })
    fs.rmSync(configDirectory, { recursive: true, force: true })
  }
}
