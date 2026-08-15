import { useEffect, useState } from 'react'
import type { AppBootstrapDataKey, Project, WorkAssistantImageAttachment } from '../../../../shared/contracts'
import { maxChatImages, prepareChatImages } from '../../chat-attachments'

interface UseGoalComposerOptions {
  selectedProjectId: string | null
  refreshDomains: (keys: readonly AppBootstrapDataKey[]) => Promise<void>
  onCreated: () => void
  onNotice: (notice: string | null) => void
}

export interface GoalComposerController {
  projectId: string | null
  text: string
  attachments: WorkAssistantImageAttachment[]
  attachmentError: string | null
  submitting: boolean
  setProjectId: (projectId: string | null) => void
  setText: (text: string) => void
  submit: () => Promise<void>
  addAttachments: (files: File[]) => Promise<void>
  removeAttachment: (id: string) => void
  dismissAttachmentError: () => void
  projectOptions: (projects: Project[]) => Array<{ value: string; label: string; accent?: string }>
}

export function useGoalComposer(options: UseGoalComposerOptions): GoalComposerController {
  const [projectId, setProjectId] = useState<string | null>(options.selectedProjectId)
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<WorkAssistantImageAttachment[]>([])
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => setProjectId(options.selectedProjectId), [options.selectedProjectId])

  async function submit(): Promise<void> {
    const prompt = text.trim()
    if ((!prompt && attachments.length === 0) || submitting) return
    setSubmitting(true)
    options.onNotice(null)
    try {
      if (!projectId) {
        options.onNotice('请先选择这个目标所属的项目。')
        return
      }
      const goal = await window.projectAgent.createGoal({
        projectId,
        prompt: prompt || '请分析附件并整理需要关注的事项。',
        attachments
      })
      options.onNotice(`目标“${goal.title}”已建立，Agent 会按 Check-in 节奏持续追踪。`)
      options.onCreated()
      setText('')
      setAttachments([])
      setAttachmentError(null)
      await options.refreshDomains(['goals'])
    } catch (error) {
      options.onNotice(error instanceof Error ? error.message : '操作失败，请稍后再试。')
    } finally {
      setSubmitting(false)
    }
  }

  async function addAttachments(files: File[]): Promise<void> {
    const result = await prepareChatImages(files, attachments.length)
    setAttachments((current) => [...current, ...result.attachments].slice(0, maxChatImages))
    setAttachmentError(result.error)
  }

  return {
    projectId,
    text,
    attachments,
    attachmentError,
    submitting,
    setProjectId,
    setText,
    submit,
    addAttachments,
    removeAttachment: (id) => {
      setAttachments((current) => current.filter((attachment) => attachment.id !== id))
      setAttachmentError(null)
    },
    dismissAttachmentError: () => setAttachmentError(null),
    projectOptions: (projects) => projects.map((project) => ({
      value: project.id,
      label: project.name,
      accent: project.accent
    }))
  }
}
