import {
  Braces,
  ChevronRight,
  Eye,
  File,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Import,
  Image as ImageIcon,
  LoaderCircle,
  Pencil,
  Save,
  Search,
  Table2,
  X
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Project, WorkspaceFileContent, WorkspaceFileEntry } from '../../../shared/contracts'
import { SelectMenu } from './SelectMenu'

interface OpenFileTab extends WorkspaceFileContent {
  draft: string
}

function formatSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_024 * 1_024) return `${Math.round(bytes / 1_024)} KB`
  return `${(bytes / 1_024 / 1_024).toFixed(1)} MB`
}

function parentPath(relativePath: string): string {
  const separator = relativePath.lastIndexOf('/')
  return separator < 0 ? '' : relativePath.slice(0, separator)
}

function joinPath(directory: string, path: string): string {
  return directory ? `${directory}/${path}` : path
}

function isMarkdown(entry: WorkspaceFileEntry): boolean {
  return entry.mimeType === 'text/markdown' || /\.(md|markdown)$/i.test(entry.name)
}

function isImage(entry: WorkspaceFileEntry): boolean {
  return entry.mimeType?.startsWith('image/') ?? false
}

function isPdf(entry: WorkspaceFileEntry): boolean {
  return entry.mimeType === 'application/pdf' || /\.pdf$/i.test(entry.name)
}

function FileTypeIcon({ entry, size = 38 }: { entry: WorkspaceFileEntry; size?: number }): React.JSX.Element {
  if (entry.kind === 'directory') return <Folder size={size} strokeWidth={1.35} />
  if (isImage(entry)) return <ImageIcon size={size} strokeWidth={1.35} />
  if (isMarkdown(entry) || entry.mimeType?.startsWith('text/')) return <FileText size={size} strokeWidth={1.35} />
  if (isPdf(entry)) return <FileText size={size} strokeWidth={1.35} />
  if (entry.mimeType?.includes('json') || /\.(json|jsonl|ya?ml)$/i.test(entry.name)) return <Braces size={size} strokeWidth={1.35} />
  if (/\.(csv|tsv)$/i.test(entry.name)) return <Table2 size={size} strokeWidth={1.35} />
  return <File size={size} strokeWidth={1.35} />
}

export function WorkspaceFilesView({
  projects,
  initialProjectId,
  onNotice
}: {
  projects: Project[]
  initialProjectId: string | null
  onNotice: (notice: string | null) => void
}): React.JSX.Element {
  const [projectId, setProjectId] = useState<string | null>(initialProjectId ?? projects[0]?.id ?? null)
  const [entries, setEntries] = useState<WorkspaceFileEntry[]>([])
  const [currentDirectory, setCurrentDirectory] = useState('')
  const [tabs, setTabs] = useState<OpenFileTab[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  const [documentMode, setDocumentMode] = useState<'preview' | 'edit'>('preview')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [openingPath, setOpeningPath] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [createMode, setCreateMode] = useState<'file' | 'directory' | null>(null)
  const [newPath, setNewPath] = useState('')

  const visibleEntries = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    const candidates = normalized
      ? entries.filter((entry) => entry.relativePath.toLowerCase().includes(normalized))
      : entries.filter((entry) => parentPath(entry.relativePath) === currentDirectory)
    return [...candidates].sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1
      return left.name.localeCompare(right.name, 'zh-CN')
    })
  }, [currentDirectory, entries, query])

  const activeTab = tabs.find((tab) => tab.entry.relativePath === activePath) ?? null
  const directorySegments = currentDirectory.split('/').filter(Boolean)

  async function load(nextProjectId = projectId): Promise<void> {
    setLoading(true)
    try {
      setEntries(await window.projectAgent.listWorkspaceFiles(nextProjectId))
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '文件列表读取失败。')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load(projectId)
  }, [projectId])

  function showFiles(directory = currentDirectory): void {
    setCurrentDirectory(directory)
    setActivePath(null)
    setQuery('')
  }

  async function openFile(entry: WorkspaceFileEntry): Promise<void> {
    const existing = tabs.find((tab) => tab.entry.relativePath === entry.relativePath)
    if (existing) {
      setActivePath(entry.relativePath)
      setDocumentMode(isMarkdown(existing.entry) ? 'preview' : 'edit')
      return
    }

    setOpeningPath(entry.relativePath)
    try {
      const result = await window.projectAgent.readWorkspaceFile(projectId, entry.relativePath)
      setTabs((current) => [...current, {
        ...result,
        draft: result.content ?? ''
      }])
      setActivePath(entry.relativePath)
      setDocumentMode(isMarkdown(result.entry) ? 'preview' : 'edit')
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '文件读取失败。')
    } finally {
      setOpeningPath(null)
    }
  }

  function closeTab(path: string): void {
    const closingIndex = tabs.findIndex((tab) => tab.entry.relativePath === path)
    const remaining = tabs.filter((tab) => tab.entry.relativePath !== path)
    setTabs(remaining)
    if (activePath === path) {
      const nextTab = remaining[Math.min(closingIndex, remaining.length - 1)]
      setActivePath(nextTab?.entry.relativePath ?? null)
      setDocumentMode(nextTab && isMarkdown(nextTab.entry) ? 'preview' : 'edit')
    }
  }

  function selectTab(tab: OpenFileTab): void {
    setActivePath(tab.entry.relativePath)
    setDocumentMode(isMarkdown(tab.entry) ? 'preview' : 'edit')
  }

  async function openEntry(entry: WorkspaceFileEntry): Promise<void> {
    if (entry.kind === 'directory') {
      showFiles(entry.relativePath)
      return
    }
    await openFile(entry)
  }

  async function createEntry(): Promise<void> {
    const path = newPath.trim()
    if (!path || !createMode) return
    const relativePath = joinPath(currentDirectory, path)
    setSaving(true)
    try {
      if (createMode === 'directory') {
        const created = await window.projectAgent.createWorkspaceFolder({ projectId, relativePath })
        setCreateMode(null)
        setNewPath('')
        await load()
        showFiles(created.relativePath)
      } else {
        const created = await window.projectAgent.writeWorkspaceFile({ projectId, relativePath, content: '' })
        setCreateMode(null)
        setNewPath('')
        await load()
        await openFile(created)
      }
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '创建失败。')
    } finally {
      setSaving(false)
    }
  }

  async function saveFile(): Promise<void> {
    if (!activeTab || activeTab.content === null) return
    setSaving(true)
    try {
      const updated = await window.projectAgent.writeWorkspaceFile({
        projectId,
        relativePath: activeTab.entry.relativePath,
        content: activeTab.draft
      })
      setTabs((current) => current.map((tab) => tab.entry.relativePath === updated.relativePath
        ? { ...tab, entry: updated, content: tab.draft }
        : tab))
      await load()
      onNotice(`已保存 ${updated.relativePath}`)
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '保存失败。')
    } finally {
      setSaving(false)
    }
  }

  async function importFiles(): Promise<void> {
    try {
      const imported = await window.projectAgent.importWorkspaceFiles(projectId, currentDirectory || undefined)
      if (imported.length > 0) {
        await load()
        onNotice(`已导入 ${imported.length} 个文件`)
      }
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '导入失败。')
    }
  }

  return (
    <section className="workspace-files-view">
      <div className="workspace-files-toolbar">
        <SelectMenu
          className="workspace-project-picker"
          value={projectId ?? ''}
          options={[
            { value: '', label: '共享文件' },
            ...projects.map((project) => ({
              value: project.id,
              label: project.name,
              icon: <span className="project-dot" style={{ background: project.accent }} />
            }))
          ]}
          onChange={(value) => {
            setProjectId(value || null)
            setCurrentDirectory('')
            setTabs([])
            setActivePath(null)
            setQuery('')
          }}
          ariaLabel="文件所属项目"
        />
        <label className="workspace-file-search">
          <Search size={14} />
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setActivePath(null)
            }}
            placeholder="搜索文件…"
          />
        </label>
        <span className="workspace-toolbar-spacer" />
        <button className="secondary-action-button" onClick={() => { setCreateMode('directory'); setNewPath('') }}>
          <FolderPlus size={14} /> 新建文件夹
        </button>
        <button className="secondary-action-button" onClick={() => { setCreateMode('file'); setNewPath('') }}>
          <FilePlus2 size={14} /> 新建文件
        </button>
        <button className="secondary-action-button" onClick={() => void importFiles()}>
          <Import size={14} /> 导入
        </button>
        <button
          className="secondary-action-button"
          onClick={() => void window.projectAgent.revealWorkspacePath(projectId, (activeTab?.entry.relativePath ?? currentDirectory) || undefined)}
        >
          <FolderOpen size={14} /> Finder
        </button>
      </div>

      {createMode && (
        <div className="workspace-create-bar">
          {createMode === 'directory' ? <FolderPlus size={15} /> : <FilePlus2 size={15} />}
          <span>{currentDirectory ? `${currentDirectory}/` : ''}</span>
          <input
            autoFocus
            value={newPath}
            onChange={(event) => setNewPath(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void createEntry() }}
            placeholder={createMode === 'directory' ? '文件夹名称' : '例如 launch-plan.md'}
          />
          <button className="primary-small-button" onClick={() => void createEntry()} disabled={!newPath.trim() || saving}>
            {saving ? <LoaderCircle size={13} className="spin" /> : '创建'}
          </button>
          <button className="round-icon-button" onClick={() => setCreateMode(null)} aria-label="取消"><X size={14} /></button>
        </div>
      )}

      <div className="workspace-document-tabs" role="tablist" aria-label="打开的文件">
        <button
          type="button"
          role="tab"
          aria-selected={activePath === null}
          className={activePath === null ? 'is-active' : ''}
          onClick={() => setActivePath(null)}
        >
          <Folder size={15} />
          <span>所有文件</span>
        </button>
        {tabs.map((tab) => {
          const dirty = tab.content !== null && tab.draft !== tab.content
          return (
            <button
              type="button"
              role="tab"
              aria-selected={activePath === tab.entry.relativePath}
              className={activePath === tab.entry.relativePath ? 'is-active' : ''}
              key={tab.entry.relativePath}
              onClick={() => selectTab(tab)}
            >
              <FileTypeIcon entry={tab.entry} size={14} />
              <span>{tab.entry.name}</span>
              {dirty && <i aria-label="未保存" />}
              <span
                className="workspace-tab-close"
                role="button"
                aria-label={`关闭 ${tab.entry.name}`}
                tabIndex={0}
                onClick={(event) => { event.stopPropagation(); closeTab(tab.entry.relativePath) }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    event.stopPropagation()
                    closeTab(tab.entry.relativePath)
                  }
                }}
              >
                <X size={12} />
              </span>
            </button>
          )
        })}
      </div>

      {activeTab ? (
        <div className="workspace-document-view">
          <div className="workspace-preview-header">
            <div>
              <strong>{activeTab.entry.name}</strong>
              <span>{activeTab.entry.relativePath} · {formatSize(activeTab.entry.size)}</span>
            </div>
            <div className="workspace-document-actions">
              {isMarkdown(activeTab.entry) && activeTab.content !== null && (
                <div className="workspace-view-switch" aria-label="Markdown 显示模式">
                  <button className={documentMode === 'preview' ? 'is-active' : ''} onClick={() => setDocumentMode('preview')}>
                    <Eye size={13} /> 预览
                  </button>
                  <button className={documentMode === 'edit' ? 'is-active' : ''} onClick={() => setDocumentMode('edit')}>
                    <Pencil size={13} /> 编辑
                  </button>
                </div>
              )}
              {activeTab.content !== null && (
                <button
                  className="secondary-action-button"
                  onClick={() => void saveFile()}
                  disabled={saving || activeTab.draft === activeTab.content}
                >
                  {saving ? <LoaderCircle size={13} className="spin" /> : <Save size={13} />} 保存
                </button>
              )}
            </div>
          </div>

          {activeTab.kind === 'markdown' && documentMode === 'preview' ? (
            <article className="workspace-markdown-preview">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{activeTab.draft}</ReactMarkdown>
            </article>
          ) : activeTab.kind === 'text' || (activeTab.kind === 'markdown' && documentMode === 'edit') ? (
            <textarea
              className="workspace-text-editor"
              value={activeTab.draft}
              onChange={(event) => {
                const draft = event.target.value
                setTabs((current) => current.map((tab) => tab.entry.relativePath === activeTab.entry.relativePath
                  ? { ...tab, draft }
                  : tab))
              }}
              spellCheck={false}
            />
          ) : activeTab.kind === 'image' && activeTab.previewUrl ? (
            <div className="workspace-image-preview">
              <img src={activeTab.previewUrl} alt={activeTab.entry.name} />
            </div>
          ) : activeTab.kind === 'pdf' && activeTab.previewUrl ? (
            <div className="workspace-pdf-preview">
              <iframe src={activeTab.previewUrl} title={`PDF 预览：${activeTab.entry.name}`} />
            </div>
          ) : (
            <div className="workspace-preview-empty">
              <FileTypeIcon entry={activeTab.entry} size={42} />
              <strong>{activeTab.entry.name}</strong>
              <span>{activeTab.previewMessage ?? `${activeTab.entry.mimeType ?? '二进制文件'} · 当前格式请在外部应用中查看。`}</span>
              <button className="secondary-action-button" onClick={() => void window.projectAgent.revealWorkspacePath(projectId, activeTab.entry.relativePath)}>
                在 Finder 中显示
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="workspace-drive-view">
          <nav className="workspace-breadcrumbs" aria-label="文件路径">
            <button onClick={() => showFiles('')}>所有文件</button>
            {directorySegments.map((segment, index) => {
              const path = directorySegments.slice(0, index + 1).join('/')
              return (
                <span key={path}>
                  <ChevronRight size={13} />
                  <button onClick={() => showFiles(path)}>{segment}</button>
                </span>
              )
            })}
          </nav>

          {loading ? (
            <div className="workspace-files-empty"><LoaderCircle size={18} className="spin" /> 正在读取文件…</div>
          ) : visibleEntries.length === 0 ? (
            <div className="workspace-files-empty">
              <Folder size={32} strokeWidth={1.35} />
              <strong>{query ? '没有找到匹配的文件' : '这个文件夹还是空的'}</strong>
              <span>{query ? '换一个关键词继续搜索。' : '导入现有文件，或让 Agent 在这里生成产物。'}</span>
            </div>
          ) : (
            <div className="workspace-file-grid">
              {visibleEntries.map((entry) => (
                <button
                  key={entry.relativePath}
                  className="workspace-file-tile"
                  onClick={() => void openEntry(entry)}
                  title={entry.relativePath}
                >
                  <span className={`workspace-file-icon ${entry.kind === 'directory' ? 'is-folder' : ''}`}>
                    {openingPath === entry.relativePath
                      ? <LoaderCircle size={28} className="spin" />
                      : <FileTypeIcon entry={entry} />}
                  </span>
                  <strong>{entry.name}</strong>
                  <small>{query ? entry.relativePath : entry.kind === 'directory' ? '文件夹' : formatSize(entry.size)}</small>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
