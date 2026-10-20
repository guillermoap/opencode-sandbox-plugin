import { describe, expect, spyOn, test } from "bun:test"
import http from "node:http"
import https from "node:https"
import net from "node:net"
import { PassThrough, Writable } from "node:stream"
import { createGitHubBridge } from "../scripts/github-http-bridge.mjs"

describe("GitHub bridge", () => {
  test("uploads retain exact body bytes and framing without body credential injection", async () => {
    const payload = Buffer.from("\0fake_value_dummy-token\xff", "latin1")
    const received: Buffer[] = []
    let forwarded: any
    const request = spyOn(https, "request").mockImplementation(((options: any, callback: any) => {
      forwarded = options
      const upstream = new Writable({
        write(chunk, _encoding, done) {
          received.push(Buffer.from(chunk))
          done()
        },
        final(done) {
          const result = Object.assign(new PassThrough(), { statusCode: 200, headers: {} })
          callback(result)
          result.end("ok")
          done()
        },
      })
      return Object.assign(upstream, { setTimeout: () => upstream })
    }) as typeof https.request)
    const server = createGitHubBridge("http://user:dummy@127.0.0.1:1")
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const address = server.address() as { port: number }
      await new Promise<void>((resolve, reject) => {
        const upload = http.request(
          {
            host: "127.0.0.1",
            port: address.port,
            method: "POST",
            path: "/repos/o/r/releases/1/assets?name=file",
            headers: {
              host: "uploads.github.com",
              authorization: "token fake_value_dummy-token",
              "content-length": String(payload.length),
            },
          },
          (response) => {
            response.resume()
            response.once("end", resolve)
          },
        )
        upload.once("error", reject)
        upload.end(payload)
      })
      expect(forwarded.headers["content-encoding"]).toBe("identity")
      expect(forwarded.headers["content-length"]).toBe(String(payload.length))
      expect(forwarded.headers.authorization).toBe("token fake_value_dummy-token")
      expect(Buffer.concat(received)).toEqual(payload)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      request.mockRestore()
    }
  })
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
