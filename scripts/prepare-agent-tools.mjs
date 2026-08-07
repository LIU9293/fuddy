import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const projectRoot = resolve(import.meta.dirname, '..')
const toolsRoot = join(projectRoot, '.third-party-tools')

const UV_VERSION = '0.12.2'
const CUA_DRIVER_VERSION = '0.19.0'

const uvArtifacts = {
  arm64: {
    name: `uv-aarch64-apple-darwin.tar.gz`,
    directory: 'uv-aarch64-apple-darwin',
    sha256: 'fa909fea3bc06f460db79017030a221fdbc43ec4478f089cb554d8335c090817'
  },
  x64: {
    name: `uv-x86_64-apple-darwin.tar.gz`,
    directory: 'uv-x86_64-apple-darwin',
    sha256: 'a6e6506a9109801222d65d17461abf4ed13bdecc5d2b13af0495418a82972c6b'
  }
}

const cuaArtifact = {
  name: `cua-driver-rs-${CUA_DRIVER_VERSION}-darwin-universal-binary.tar.gz`,
  sha256: 'aab9ef22de41c9e0c591593f9a195e4ea88b21bd5f66f1eb1e071dcc8d16ae32'
}

async function sha256(path) {
  const hash = createHash('sha256')
  hash.update(await readFile(path))
  return hash.digest('hex')
}

async function download(url, destination, expectedSha256) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`下载失败（${response.status}）：${url}`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  await writeFile(destination, bytes)
  const actual = await sha256(destination)
  if (actual !== expectedSha256) {
    throw new Error(`SHA-256 不匹配：${destination}\nexpected ${expectedSha256}\nactual   ${actual}`)
  }
}

async function extractTar(archive, destination) {
  await mkdir(destination, { recursive: true })
  await execFileAsync('tar', ['-xzf', archive, '-C', destination])
}

async function prepareUv(workDirectory, arch) {
  const artifact = uvArtifacts[arch]
  if (!artifact) throw new Error(`不支持的 macOS 架构：${arch}`)
  const destination = join(toolsRoot, 'uv', `darwin-${arch}`, 'uv')
  const archive = join(workDirectory, artifact.name)
  await download(
    `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${artifact.name}`,
    archive,
    artifact.sha256
  )
  const extracted = join(workDirectory, 'uv')
  await extractTar(archive, extracted)
  await mkdir(dirname(destination), { recursive: true })
  await copyFile(join(extracted, artifact.directory, 'uv'), destination)
  await chmod(destination, 0o755)
  return destination
}

async function prepareCuaDriver(workDirectory) {
  const destination = join(toolsRoot, 'cua-driver', 'darwin-universal', 'cua-driver')
  const archive = join(workDirectory, cuaArtifact.name)
  await download(
    `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${CUA_DRIVER_VERSION}/${cuaArtifact.name}`,
    archive,
    cuaArtifact.sha256
  )
  const extracted = join(workDirectory, 'cua-driver')
  await extractTar(archive, extracted)
  await mkdir(dirname(destination), { recursive: true })
  await copyFile(join(extracted, 'cua-driver'), destination)
  await chmod(destination, 0o755)
  return destination
}

if (process.platform !== 'darwin') {
  throw new Error('当前 Project Agent 发行流程只准备 macOS Agent 工具。')
}

const markerPath = join(toolsRoot, 'versions.json')
let marker = null
try {
  marker = JSON.parse(await readFile(markerPath, 'utf8'))
} catch {
  marker = null
}

const expectedMarker = { uv: UV_VERSION, browserUse: '0.13.7', cuaDriver: CUA_DRIVER_VERSION, arch: process.arch }
if (JSON.stringify(marker) === JSON.stringify(expectedMarker)) {
  console.log(`Agent tools already prepared: Browser Use ${expectedMarker.browserUse}, CUA Driver ${expectedMarker.cuaDriver}`)
  process.exit(0)
}

const workDirectory = await mkdtemp(join(tmpdir(), 'project-agent-tools-'))
try {
  await rm(toolsRoot, { recursive: true, force: true })
  const [uvPath, cuaPath] = await Promise.all([
    prepareUv(workDirectory, process.arch),
    prepareCuaDriver(workDirectory)
  ])
  await writeFile(markerPath, `${JSON.stringify(expectedMarker, null, 2)}\n`)
  console.log(`Prepared uv: ${uvPath}`)
  console.log(`Prepared CUA Driver: ${cuaPath}`)
} finally {
  await rm(workDirectory, { recursive: true, force: true })
}
