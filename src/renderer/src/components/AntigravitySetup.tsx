import { useEffect, useState } from 'react'
import type { AntigravitySetupInput, AntigravitySetupState } from '../../../shared/antigravity-setup'

const installing = new Set(['downloading', 'extracting', 'verifying'])
const signingIn = new Set(['starting', 'waiting', 'verifying'])

export function AntigravitySetup({ onReady }: { onReady: () => void }): React.JSX.Element {
  const [state, setState] = useState<AntigravitySetupState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isInstalling = installing.has(state?.installPhase ?? '')
  const isSigningIn = signingIn.has(state?.authPhase ?? '')

  useEffect(() => {
    let active = true
    const refresh = () => void window.projectAgent.manageAntigravity({ operation: 'status' }).then(value => {
      if (active) setState(value)
    }).catch(() => {
      if (active) setError('无法读取 Antigravity 设置状态。')
    })
    refresh()
    const timer = isInstalling || isSigningIn ? window.setInterval(refresh, 1_500) : undefined
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [isInstalling, isSigningIn])

  useEffect(() => {
    if (state?.authPhase === 'succeeded') onReady()
  }, [state?.authPhase])

  async function run(input: AntigravitySetupInput): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      setState(await window.projectAgent.manageAntigravity(input))
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'Antigravity 设置失败。')
    } finally {
      setBusy(false)
    }
  }

  return <div className="settings-list-section-spacing">
    {state && !state.installed && <button type="button" className="settings-row-button"
      disabled={busy || isInstalling} onClick={() => void run({ operation: 'install' })}>
      {isInstalling ? '正在安装…' : '安装 Antigravity'}
    </button>}
    {state?.installed && !isSigningIn && state.authPhase !== 'succeeded' &&
      <button type="button" className="settings-row-button" disabled={busy}
        onClick={() => void run({ operation: 'sign-in' })}>登录 Google</button>}
    {isSigningIn && state?.canOpenSignIn && state.flowId && <>
      <button type="button" className="settings-row-button" disabled={busy}
        onClick={() => void run({ operation: 'open-sign-in' })}>打开 Google 登录</button>
      <form className="settings-setup-row" onSubmit={event => {
        event.preventDefault()
        const form = event.currentTarget
        const callbackUrl = String(new FormData(form).get('callbackUrl') ?? '').trim()
        if (callbackUrl && state.flowId) {
          form.reset()
          void run({ operation: 'finish-sign-in', callbackUrl, flowId: state.flowId })
        }
      }}>
        <label htmlFor="antigravity-callback">登录完成后的重定向地址</label>
        <input id="antigravity-callback" name="callbackUrl" type="url" maxLength={16_384} autoComplete="off" required />
        <button type="submit" className="settings-row-button" disabled={busy}>完成登录</button>
      </form>
    </>}
    {isSigningIn && state?.flowId && <button type="button" className="settings-row-button" disabled={busy}
      onClick={() => { if (state.flowId) void run({ operation: 'cancel-sign-in', flowId: state.flowId }) }}>取消登录</button>}
    {state?.installPhase === 'failed' && <p role="alert">安装失败，可以重新尝试。</p>}
    {state?.authPhase === 'failed' && <p role="alert">登录失败，可以重新尝试。</p>}
    {state?.authPhase === 'succeeded' && <p role="status">已登录 Google。</p>}
    {error && <p role="alert">{error}</p>}
  </div>
}
