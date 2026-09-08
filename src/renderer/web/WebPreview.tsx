import { useEffect, useState } from 'react'
import App from '../src/App'
import { PreviewUnavailableError } from './preview-api'

const defaultNotice = '仅示例数据 · 修改保存在页面内存 · 刷新可重置'

export default function WebPreview({ empty }: { empty: boolean }): React.JSX.Element {
  const [notice, setNotice] = useState(defaultNotice)
  useEffect(() => {
    if (notice === defaultNotice) return
    const timer = window.setTimeout(() => setNotice(defaultNotice), 5000)
    return () => window.clearTimeout(timer)
  }, [notice])
  useEffect(() => {
    const onRejection = (event: PromiseRejectionEvent): void => {
      if (!(event.reason instanceof PreviewUnavailableError)) return
      event.preventDefault()
      setNotice(event.reason.message)
    }
    window.addEventListener('unhandledrejection', onRejection)
    return () => window.removeEventListener('unhandledrejection', onRejection)
  }, [])

  return <div className="web-preview">
    <aside className="web-preview-toolbar" aria-label="Web 预览工具栏">
      <strong>Fuddy Dev · Web 预览</strong>
      <span role="status">{notice}</span>
      <label>数据
        <select aria-label="预览数据" value={empty ? 'empty' : 'sample'} onChange={(event) => {
          const url = new URL(location.href)
          url.searchParams.set('fixture', event.target.value)
          location.assign(url)
        }}>
          <option value="sample">示例</option>
          <option value="empty">空状态</option>
        </select>
      </label>
      <button type="button" onClick={() => location.reload()}>重置预览</button>
    </aside>
    <div className="web-preview-app"><App /></div>
  </div>
}
