import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
execFileSync("git", ["diff", "--exit-code", "HEAD"], { stdio: "inherit" })
const { version } = JSON.parse(await fs.readFile("package.json", "utf8"))
const tag = `v${version}`
const directory = path.resolve("release")
await fs.mkdir(directory, { recursive: true })
const result = await Bun.build({
  entrypoints: ["scripts/setup.mjs"],
  target: "node",
  format: "esm",
  minify: false,
  // Its UMD entrypoint passes require through a factory, which cannot be
  // statically bundled. Use the package's ESM build for a standalone payload.
  plugins: [
    {
      name: "jsonc-parser-esm",
      setup(build) {
        build.onResolve({ filter: /^jsonc-parser$/ }, () => ({
          path: path.resolve("node_modules/jsonc-parser/lib/esm/main.js"),
        }))
      },
    },
  ],
})
if (!result.success) throw new Error(JSON.stringify(result.logs))
const notice = await fs.readFile("node_modules/jsonc-parser/LICENSE.md", "utf8")
const code = (await result.outputs[0].text()).replaceAll("__OPENCODE_SANDBOX_REVISION__", revision)
const payload = `/*! Bundled jsonc-parser license:\n${notice}\n*/\n${code}`
await fs.writeFile(path.join(directory, "setup.mjs"), payload)
execFileSync("node", [path.join(directory, "setup.mjs"), "--help"], { stdio: "pipe" })
const checksum = createHash("sha256").update(payload).digest("hex")
const bootstrap = (await fs.readFile("scripts/install.sh", "utf8"))
  .replaceAll("__OPENCODE_SANDBOX_TAG__", tag)
  .replaceAll("__OPENCODE_SANDBOX_REVISION__", revision)
  .replaceAll("__OPENCODE_SANDBOX_SHA256__", checksum)
await fs.writeFile(path.join(directory, "install.sh"), bootstrap, { mode: 0o755 })
const checksums = ["setup.mjs", "install.sh"]
  .map((name) => {
    const content = name === "setup.mjs" ? payload : bootstrap
    return `${createHash("sha256").update(content).digest("hex")}  ${name}\n`
  })
  .join("")
await fs.writeFile(path.join(directory, "SHA256SUMS"), checksums)
console.log(`Built ${tag} for ${revision} in ${directory}`)
