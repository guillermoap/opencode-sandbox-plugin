import { describe, expect, test } from "bun:test"
import net from "node:net"
import { createGitHubBridge } from "../scripts/github-http-bridge.mjs"

describe("GitHub bridge", () => {
  test("requires an authenticated local proxy", () => {
    for (const proxy of [
      "http://localhost:1234",
      "https://user:pass@localhost:1234",
      "http://user:pass@example.com:1234",
    ]) {
      expect(() => createGitHubBridge(proxy)).toThrow("Authenticated local HTTP proxy required")
    }
  })

  test("rejects non-GitHub destinations and absolute request targets", async () => {
    const server = createGitHubBridge("http://user:dummy@127.0.0.1:1")
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const address = server.address() as { port: number }
      for (const [host, url] of [
        ["evil.example", "/"],
        ["api.github.com.evil.example", "/"],
        ["api.github.com:8443", "/"],
        ["api.github.com", "https://evil.example/"],
        ["api.github.com", "//evil.example/"],
      ]) {
        const status = await new Promise((resolve, reject) => {
          const socket = net.connect(address.port, "127.0.0.1", () =>
            socket.write(`GET ${url} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`),
          )
          let response = ""
          socket.on("data", (chunk) => {
            response += chunk.toString()
          })
          socket.once("end", () => resolve(Number(response.split(" ")[1])))
          socket.once("error", reject)
        })
        expect([400, 403]).toContain(status)
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
