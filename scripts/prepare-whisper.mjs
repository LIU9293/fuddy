import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, copyFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import { arch } from 'node:process'
import { join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { spawn } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const version = 'v1.9.2'
const modelName = 'ggml-large-v3-turbo-q5_0.bin'
const modelSize = 574_041_195
const modelSha256 = '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2'
const archiveSize = 53_575_921
const archiveSha256 = 'af74fed13ea7f2d5ca2a39d9f58ec177713fafd7cab63aef4e27b79f3ceca80b'
const releaseRoot = join(root, '.third-party-tools', 'whisper', version)
const archivePath = join(releaseRoot, `whisper-${version}-xcframework.zip`)
const frameworkPath = join(releaseRoot, 'build-apple', 'whisper.xcframework')
const modelPath = join(root, '.third-party-tools', 'whisper', 'models', modelName)
const platformArch = arch === 'arm64' ? 'arm64' : 'x64'
const outputRoot = join(root, '.third-party-tools', 'whisper', `darwin-${platformArch}`)
const helperPath = join(outputRoot, 'whisper-helper')
const macFrameworkSource = join(frameworkPath, 'macos-arm64_x86_64', 'whisper.framework')
const macFrameworkDestination = join(outputRoot, 'whisper.framework')
const iosRequested = process.argv.includes('--ios')

async function download(url, destination) {
  const partial = `${destination}.partial`
  await mkdir(resolve(destination, '..'), { recursive: true })
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`下载失败：${response.status} ${response.statusText}`)
  await pipeline(response.body, createWriteStream(partial))
  await rename(partial, destination)
}

async function run(command, args) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} 退出码 ${code}`)))
  })
}

async function exists(path) {
  try { await stat(path); return true } catch { return false }
}

async function sha256(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

await mkdir(releaseRoot, { recursive: true })
let validArchive = false
if (await exists(archivePath)) {
  const info = await stat(archivePath)
  validArchive = info.size === archiveSize && await sha256(archivePath) === archiveSha256
}
if (!validArchive) {
  await rm(archivePath, { force: true })
  console.info(`[whisper] 下载官方 XCFramework ${version}`)
  await download(
    `https://github.com/ggml-org/whisper.cpp/releases/download/${version}/whisper-${version}-xcframework.zip`,
    archivePath
  )
  const info = await stat(archivePath)
  const digest = await sha256(archivePath)
  if (info.size !== archiveSize || digest !== archiveSha256) {
    await rm(archivePath, { force: true })
    throw new Error('Whisper XCFramework 校验失败。')
  }
}
if (!await exists(frameworkPath)) {
  console.info('[whisper] 解压 XCFramework')
  await run('ditto', ['-x', '-k', archivePath, releaseRoot])
}

await mkdir(outputRoot, { recursive: true })
await rm(macFrameworkDestination, { recursive: true, force: true })
await run('ditto', [macFrameworkSource, macFrameworkDestination])
console.info('[whisper] 编译 macOS 原生 helper')
await run('xcrun', [
  'swiftc', '-O',
  join(root, 'native', 'whisper-helper', 'main.swift'),
  '-F', join(frameworkPath, 'macos-arm64_x86_64'),
  '-framework', 'whisper',
  '-Xlinker', '-rpath', '-Xlinker', '@executable_path',
  '-o', helperPath
])
await chmod(helperPath, 0o755)

if (iosRequested) {
  let validModel = false
  if (await exists(modelPath)) {
    const info = await stat(modelPath)
    validModel = info.size === modelSize && await sha256(modelPath) === modelSha256
  }
  if (!validModel) {
    await rm(modelPath, { force: true })
    console.info('[whisper] 下载 iOS 预置 large-v3-turbo Q5 模型（约 547 MiB）')
    await download(
      `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${modelName}`,
      modelPath
    )
    const info = await stat(modelPath)
    const digest = await sha256(modelPath)
    if (info.size !== modelSize || digest !== modelSha256) {
      await rm(modelPath, { force: true })
      throw new Error('Whisper 模型校验失败。')
    }
  }
  const iosModel = join(root, 'ios', 'ProjectAgentCompanion', 'Resources', 'Whisper', modelName)
  await mkdir(resolve(iosModel, '..'), { recursive: true })
  await copyFile(modelPath, iosModel)
  console.info(`[whisper] iOS 模型已预置：${iosModel}`)
}

console.info(`[whisper] helper 已就绪：${helperPath}`)
