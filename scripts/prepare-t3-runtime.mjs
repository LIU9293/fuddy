import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const vendor = join(root, 'vendor', 't3-code')
const revision = JSON.parse(readFileSync(join(vendor, 'revision.json'), 'utf8'))
const toolsDirectory = join(root, '.third-party-tools')
const checkout = join(toolsDirectory, 't3-source', revision.commit)
const output = join(toolsDirectory, 't3-runtime')
const marker = join(output, 'revision')
const fingerprint = createHash('sha256')
for (const file of [
  ...['revision.json', 'FuddyBridge.ts', 'FuddyProjectTool.ts', 'FuddyTurnContext.ts', 'LICENSE'].map(file => join(vendor, file)),
  fileURLToPath(import.meta.url),
  join(root, 'scripts', 'patch-t3-runtime.mjs')
]) fingerprint.update(readFileSync(file))
const version = `${revision.commit}-${process.platform}-${process.arch}-${fingerprint.digest('hex')}`
if (existsSync(marker) && readFileSync(marker, 'utf8') === version) process.exit(0)

function run(command, args, cwd = root, options = {}) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed with exit status ${result.status ?? result.signal}`)
  return result.stdout?.trim()
}

if (!existsSync(join(checkout, '.git'))) {
  mkdirSync(checkout, { recursive: true })
  run('git', ['init', '--quiet'], checkout)
}
const current = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' })
if (current.status !== 0) {
  const local = [resolve(root, '..', 't3code'), join(homedir(), 'Code', 't3code')].find(directory =>
    spawnSync('git', ['-C', directory, 'cat-file', '-e', `${revision.commit}^{commit}`], { stdio: 'ignore' }).status === 0)
  run('git', ['fetch', '--depth=1', local ?? revision.repository, revision.commit], checkout)
  run('git', ['checkout', '--detach', 'FETCH_HEAD'], checkout)
} else if (current.stdout.trim() !== revision.commit) {
  throw new Error('Unexpected T3 Code source revision.')
}

run(process.execPath, [join(root, 'scripts', 'patch-t3-runtime.mjs'), checkout])
const pnpm = process.env.FUDDY_T3_PNPM || 'pnpm'
const server = join(checkout, 'apps', 'server')
run(pnpm, ['install', '--frozen-lockfile', '--filter', 't3...', '--fetch-timeout=30000'], checkout, {
  env: { ...process.env, CI: 'true' }
})
run(process.execPath, ['--run', 'build:bundle'], server)

const staging = join(toolsDirectory, `t3-runtime-stage-${process.pid}`)
const sourceStore = join(checkout, 'node_modules', '.pnpm')
const destinationStore = join(staging, 'node_modules', '.pnpm')
const staged = new Set()

function stageModule(packageDirectory) {
  const sourcePath = realpathSync(packageDirectory)
  const storePath = relative(sourceStore, sourcePath)
  if (storePath.startsWith('..') || isAbsolute(storePath)) throw new Error(`Unbundled workspace dependency: ${sourcePath}`)
  const storeRoot = storePath.split('/')[0]
  if (staged.has(storeRoot)) return storePath
  staged.add(storeRoot)
  const storeModuleDirectory = join(sourceStore, storeRoot, 'node_modules')
  cpSync(join(sourceStore, storeRoot), join(destinationStore, storeRoot), { recursive: true, verbatimSymlinks: true })
  for (const entry of readdirSync(storeModuleDirectory)) {
    const directory = join(storeModuleDirectory, entry)
    const modules = entry.startsWith('@') && lstatSync(directory).isDirectory()
      ? readdirSync(directory).map(name => join(directory, name))
      : [directory]
    for (const module of modules) {
      if (!lstatSync(module).isSymbolicLink()) continue
      const target = resolve(dirname(module), readlinkSync(module))
      stageModule(target)
    }
  }
  return storePath
}

const { selectCliRuntimeExternalDependencies } = await import(pathToFileURL(join(
  checkout, 'scripts', 'lib', 'cli-external-packages.ts'
)).href)
const { dependencies } = JSON.parse(readFileSync(join(server, 'package.json'), 'utf8'))
const externalPackages = Object.keys(selectCliRuntimeExternalDependencies(dependencies))

try {
  mkdirSync(destinationStore, { recursive: true })
  const serverDist = join(server, 'dist')
  cpSync(serverDist, join(staging, 'dist'), {
    recursive: true, filter: path => !path.endsWith('.map') && basename(path) !== 'client'
  })
  for (const name of externalPackages) {
    const installed = join(server, 'node_modules', name)
    const storePath = stageModule(installed)
    const link = join(staging, 'node_modules', name)
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(relative(dirname(link), join(destinationStore, storePath)), link, 'dir')
  }
  cpSync(join(vendor, 'LICENSE'), join(staging, 'LICENSE'))
  cpSync(join(vendor, 'revision.json'), join(staging, 'revision.json'))
  run(process.execPath, [join(staging, 'dist', 'bin.mjs'), '--version'], staging)
  writeFileSync(join(staging, 'revision'), version)
  rmSync(output, { recursive: true, force: true })
  renameSync(staging, output)
} finally {
  rmSync(staging, { recursive: true, force: true })
}
