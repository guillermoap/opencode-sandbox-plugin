import net from "node:net"

const [host, portText] = process.argv.slice(2)
const port = Number(portText)
if (
  !host ||
  !/^[a-zA-Z0-9.-]+$/.test(host) ||
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535
) {
  console.error("Invalid SSH destination")
  process.exit(1)
}
let proxy
try {
  proxy = new URL(process.env.HTTPS_PROXY ?? "")
} catch {
  /* Rejected below. */
}
if (
  !proxy ||
  proxy.protocol !== "http:" ||
  !["localhost", "127.0.0.1", "[::1]"].includes(proxy.hostname) ||
  !proxy.username ||
  !proxy.password
) {
  console.error("Authenticated local HTTP proxy required")
  process.exit(1)
}
const socket = net.connect(Number(proxy.port || 80), proxy.hostname.replace(/^\[|\]$/g, ""))
socket.setTimeout(15000)
socket.once("connect", () => {
  const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`
  socket.write(
    `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\nProxy-Authorization: Basic ${Buffer.from(credentials).toString("base64")}\r\n\r\n`,
  )
})
let headers = Buffer.alloc(0)
let connected = false
function onHeaderData(chunk) {
  headers = Buffer.concat([headers, chunk])
  const end = headers.indexOf("\r\n\r\n")
  if (end > 16384 || (end < 0 && headers.length > 16384))
    return socket.destroy(new Error("Proxy response too large"))
  if (end < 0) return
  const status = headers.subarray(0, end).toString("ascii").split("\r\n", 1)[0]
  if (!/^HTTP\/1\.[01] 200(?: |$)/.test(status))
    return socket.destroy(new Error("SSH proxy refused connection"))
  connected = true
  socket.setTimeout(0)
  socket.off("data", onHeaderData)
  const remainder = headers.subarray(end + 4)
  if (remainder.length) process.stdout.write(remainder)
  process.stdin.pipe(socket)
  socket.pipe(process.stdout)
}
socket.on("data", onHeaderData)
socket.on("end", () => {
  if (!connected) socket.destroy(new Error("SSH proxy closed before the tunnel opened"))
})
socket.on("timeout", () => socket.destroy(new Error("SSH proxy timed out")))
socket.on("error", (error) => {
  console.error(error.message)
  process.exitCode = 1
})
