import {
  Check,
  ChevronLeft,
  FolderOpen,
  Laptop,
  LoaderCircle,
  Mail,
  RefreshCw
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type {
  AccountState,
  AgentDetectionResult,
  StartEmailSignInResult
} from '../../../../shared/account'
import fuddyWordmark from '../../assets/fuddy-wordmark.png'
import { userFacingErrorMessage } from '../../user-facing-error'

export interface AccountOnboardingProps {
  state: AccountState
  onStateChange: (state: AccountState) => void
}

type BusyAction = 'email' | 'verify' | 'google' | null

function errorMessage(error: unknown, fallback: string): string {
  return userFacingErrorMessage(error, fallback)
}

function projectNameFromPath(path: string): string {
  const normalized = path.replace(/\/+$/u, '')
  return normalized.split('/').filter(Boolean).at(-1) ?? '我的项目'
}

function EntryChrome({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="account-entry-shell">
      <header className="account-entry-titlebar">
        <div className="window-drag-region" />
      </header>
      {children}
    </div>
  )
}

function LoginView({ state, onStateChange }: AccountOnboardingProps): React.JSX.Element {
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [challenge, setChallenge] = useState<StartEmailSignInResult | null>(null)
  const [busy, setBusy] = useState<BusyAction>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [retryAt, setRetryAt] = useState(0)

  useEffect(() => {
    if (!challenge) return
    const expiresAt = new Date(challenge.expiresAt).getTime()
    if (Math.max(retryAt, expiresAt) <= Date.now()) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [challenge, retryAt])

  async function startEmail(): Promise<void> {
    if (!email.trim() || busy) return
    setBusy('email')
    setError(null)
    try {
      const nextChallenge = await window.projectAgent.startEmailSignIn(email)
      setChallenge(nextChallenge)
      setRetryAt(Date.now() + nextChallenge.retryAfterSeconds * 1_000)
      setNow(Date.now())
      setCode('')
    } catch (caught) {
      setError(errorMessage(caught, '验证码发送失败，请重试。'))
    } finally {
      setBusy(null)
    }
  }

  const resendRemaining = Math.max(0, Math.ceil((retryAt - now) / 1_000))

  async function verify(): Promise<void> {
    if (!challenge || code.length !== 6 || busy) return
    setBusy('verify')
    setError(null)
    try {
      onStateChange(await window.projectAgent.verifyEmailSignIn({ challengeId: challenge.challengeId, code }))
    } catch (caught) {
      setError(errorMessage(caught, '验证码验证失败，请重试。'))
    } finally {
      setBusy(null)
    }
  }

  async function signInWithGoogle(): Promise<void> {
    if (!state.availableProviders.google || busy) return
    setBusy('google')
    setError(null)
    try {
      onStateChange(await window.projectAgent.signInWithGoogle())
    } catch (caught) {
      setError(errorMessage(caught, 'Google 登录没有完成。'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <EntryChrome>
      <main className="account-entry-main">
        <section className="account-entry-panel" aria-labelledby="account-entry-title">
          <img className="account-wordmark-mark" src={fuddyWordmark} alt="Fuddy" />
          {challenge ? (
            <>
              <button className="account-back-button" type="button" onClick={() => { setChallenge(null); setError(null) }}>
                <ChevronLeft size={15} /> 更换邮箱
              </button>
              <h1 id="account-entry-title">输入验证码</h1>
              <p className="account-lede">验证码已发送至 <strong>{challenge.email}</strong>，10 分钟内有效。</p>
              <form className="account-form" onSubmit={(event) => { event.preventDefault(); void verify() }}>
                <label htmlFor="account-code">验证码</label>
                <input
                  id="account-code"
                  className="account-code-input"
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/gu, '').slice(0, 6))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  placeholder="6 位数字"
                  aria-describedby={error ? 'account-entry-error' : undefined}
                />
                {error && <p className="account-entry-error" id="account-entry-error" role="alert">{error}</p>}
                <button className="account-primary-button" type="submit" disabled={code.length !== 6 || Boolean(busy)}>
                  {busy === 'verify' && <LoaderCircle className="spin" size={15} />}
                  登录
                </button>
                <button
                  className="account-secondary-button"
                  type="button"
                  disabled={Boolean(busy) || resendRemaining > 0}
                  onClick={() => void startEmail()}
                >
                  {resendRemaining > 0 ? `重新发送（${resendRemaining} 秒）` : '重新发送验证码'}
                </button>
              </form>
            </>
          ) : (
            <>
              <p className="account-eyebrow">欢迎来到 Fuddy</p>
              <h1 id="account-entry-title">登录或注册 Fuddy</h1>
              <p className="account-lede">让项目在 Mac 和 iPhone 之间无缝继续。</p>
              {state.availableProviders.google && (
                <>
                  <button
                    className="account-provider-button"
                    type="button"
                    disabled={Boolean(busy)}
                    onClick={() => void signInWithGoogle()}
                  >
                    {busy === 'google' && <LoaderCircle className="spin" size={15} />}
                    使用 Google 继续
                  </button>
                  <div className="account-divider"><span>或</span></div>
                </>
              )}
              <form className="account-form" onSubmit={(event) => { event.preventDefault(); void startEmail() }}>
                <label htmlFor="account-email">邮箱地址</label>
                <div className="account-input-with-icon">
                  <Mail size={16} aria-hidden="true" />
                  <input
                    id="account-email"
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    autoComplete="email"
                    autoFocus
                    placeholder="you@example.com"
                    aria-describedby={error ? 'account-entry-error' : undefined}
                  />
                </div>
                {error && <p className="account-entry-error" id="account-entry-error" role="alert">{error}</p>}
                {state.serviceMessage && <p className="account-entry-error" role="status">{state.serviceMessage}</p>}
                <button className="account-primary-button" type="submit" disabled={!email.trim() || Boolean(busy)}>
                  {busy === 'email' && <LoaderCircle className="spin" size={15} />}
                  用邮箱继续
                </button>
              </form>
              <p className="account-legal">我们会向你的邮箱发送一次性验证码。</p>
            </>
          )}
        </section>
      </main>
    </EntryChrome>
  )
}

function OnboardingProgress({ step }: { step: NonNullable<AccountState['onboarding']>['step'] }): React.JSX.Element {
  const steps = [
    { id: 'detect-agent', label: '检测 Agent' },
    { id: 'add-project', label: '添加项目' }
  ] as const
  const currentIndex = Math.max(0, steps.findIndex((item) => item.id === step))
  return (
    <ol className="onboarding-progress" aria-label="设置进度">
      {steps.map((item, index) => (
        <li className={index < currentIndex ? 'is-complete' : index === currentIndex ? 'is-current' : ''} key={item.id}>
          <span>{index < currentIndex ? <Check size={12} /> : index + 1}</span>
          <small>{item.label}</small>
        </li>
      ))}
    </ol>
  )
}

function AgentStep({ onStateChange }: Pick<AccountOnboardingProps, 'onStateChange'>): React.JSX.Element {
  const [result, setResult] = useState<AgentDetectionResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const codingAgents = useMemo(
    () => result?.capabilities.filter((item) => ['pi', 'codex', 'claude', 'opencode'].includes(item.id)) ?? [],
    [result]
  )

  async function detect(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      setResult(await window.projectAgent.detectCodingAgents())
    } catch (caught) {
      setError(errorMessage(caught, 'Coding Agent 检测失败。'))
    } finally {
      setBusy(false)
    }
  }

  async function continueSetup(): Promise<void> {
    setBusy(true)
    try {
      onStateChange(await window.projectAgent.completeAgentDetection())
    } catch (caught) {
      setError(errorMessage(caught, '无法继续设置。'))
      setBusy(false)
    }
  }

  return (
    <section className="onboarding-step" aria-labelledby="onboarding-title">
      <div className="onboarding-icon" aria-hidden="true"><Laptop size={22} /></div>
      <p className="account-eyebrow">第 1 步</p>
      <h1 id="onboarding-title">检查 Coding Agent</h1>
      <p className="account-lede">Fuddy 会检查这台 Mac 上可用的 Coding Agent，你稍后也可以在设置中更改。</p>
      {codingAgents.length > 0 && (
        <div className="agent-detection-list" aria-live="polite">
          {codingAgents.map((agent) => (
            <div key={agent.id}>
              <span className={agent.status === 'ready' ? 'status-dot is-ready' : 'status-dot'} />
              <strong>{agent.label}</strong>
              <small>{agent.status === 'ready' ? '可用' : '未安装'}</small>
            </div>
          ))}
        </div>
      )}
      {error && <p className="account-entry-error" role="alert">{error}</p>}
      <div className="onboarding-actions">
        {!result ? (
          <button className="account-primary-button" type="button" disabled={busy} onClick={() => void detect()}>
            {busy ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />} 检查可用 Agent
          </button>
        ) : (
          <button className="account-primary-button" type="button" disabled={busy} onClick={() => void continueSetup()}>
            继续
          </button>
        )}
      </div>
    </section>
  )
}

function ProjectStep({ state, onStateChange }: AccountOnboardingProps): React.JSX.Element {
  const [workspacePath, setWorkspacePath] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function chooseFolder(): Promise<void> {
    const path = await window.projectAgent.selectOnboardingProjectFolder()
    if (!path) return
    setWorkspacePath(path)
    setName(projectNameFromPath(path))
  }

  async function complete(skip: boolean): Promise<void> {
    if (!skip && (!workspacePath || !name.trim())) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.projectAgent.completeProjectOnboarding({
        project: skip ? null : {
          name: name.trim(),
          summary: '从 Fuddy 初始设置添加的项目。',
          focus: '完成项目初始设置',
          mission: '持续推进这个项目并保留可追溯的上下文。',
          vision: '让项目的决策、文件和行动在 Fuddy 中持续衔接。',
          productType: '未设置',
          stage: '起步阶段',
          workspacePath
        }
      })
      onStateChange(result.account)
    } catch (caught) {
      setError(errorMessage(caught, '项目添加失败。'))
      setBusy(false)
    }
  }

  return (
    <section className="onboarding-step" aria-labelledby="onboarding-title">
      <div className="onboarding-icon" aria-hidden="true"><FolderOpen size={22} /></div>
      <p className="account-eyebrow">第 2 步</p>
      <h1 id="onboarding-title">添加第一个项目</h1>
      <p className="account-lede">选择项目所在的文件夹，Fuddy 会在原位置使用它。</p>
      {state.existingProjectCount > 0 && !workspacePath && (
        <div className="existing-projects-note">
          <Check size={16} />
          <span><strong>已找到 {state.existingProjectCount} 个项目</strong><small>可以直接继续，也可以再添加一个。</small></span>
        </div>
      )}
      <button className="project-folder-picker" type="button" onClick={() => void chooseFolder()}>
        <FolderOpen size={17} />
        <span>{workspacePath ?? (state.existingProjectCount > 0 ? '添加另一个项目文件夹' : '选择项目文件夹')}</span>
      </button>
      {workspacePath && (
        <label className="onboarding-field">
          <span>项目名称</span>
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={200} autoFocus />
        </label>
      )}
      {error && <p className="account-entry-error" role="alert">{error}</p>}
      <div className="onboarding-actions is-split">
        <button className="account-secondary-button" type="button" disabled={busy} onClick={() => void complete(true)}>
          {state.existingProjectCount > 0 ? '使用已有项目' : '暂时跳过'}
        </button>
        <button className="account-primary-button" type="button" disabled={busy || !workspacePath || !name.trim()} onClick={() => void complete(false)}>
          {busy && <LoaderCircle className="spin" size={15} />} 添加并继续
        </button>
      </div>
    </section>
  )
}

function SetupView({ state, onStateChange }: AccountOnboardingProps): React.JSX.Element {
  const [logoutBusy, setLogoutBusy] = useState(false)
  const step = state.onboarding?.step ?? 'detect-agent'

  async function logout(): Promise<void> {
    setLogoutBusy(true)
    try {
      onStateChange(await window.projectAgent.logoutAccount())
    } finally {
      setLogoutBusy(false)
    }
  }

  return (
    <EntryChrome>
      <button className="account-user-button" type="button" disabled={logoutBusy} onClick={() => void logout()}>
        {state.user?.email} · 退出
      </button>
      <main className="account-entry-main onboarding-main">
        <div className="onboarding-panel">
          {step === 'detect-agent' && <AgentStep onStateChange={onStateChange} />}
          {step === 'add-project' && <ProjectStep state={state} onStateChange={onStateChange} />}
          <OnboardingProgress step={step} />
        </div>
      </main>
    </EntryChrome>
  )
}

export function AccountOnboarding(props: AccountOnboardingProps): React.JSX.Element {
  if (props.state.status === 'signed-out') return <LoginView {...props} />
  return <SetupView {...props} />
}

export { projectNameFromPath }
