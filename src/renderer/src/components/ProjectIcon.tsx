import type { CSSProperties } from 'react'
import type { Project } from '../../../shared/contracts'

export function isProjectImageIcon(icon: string | null | undefined): icon is string {
  return /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(icon?.trim() ?? '')
}

export function projectIconText(project: Pick<Project, 'icon' | 'name'>): string {
  const customIcon = project.icon?.trim()
  if (customIcon && !isProjectImageIcon(customIcon)) return customIcon
  return Array.from(project.name.trim())[0]?.toLocaleUpperCase() ?? '?'
}

export function ProjectIcon({
  project,
  className = ''
}: {
  project: Pick<Project, 'icon' | 'name' | 'accent'>
  className?: string
}): React.JSX.Element {
  const icon = project.icon
  const imageIcon = isProjectImageIcon(icon)
  const textIcon = projectIconText(project)
  const wordmark = !imageIcon && Array.from(textIcon).length > 2
  return (
    <span
      className={`project-icon ${imageIcon ? 'has-image' : ''} ${wordmark ? 'is-wordmark' : ''} ${className}`.trim()}
      style={{ '--project-accent': project.accent } as CSSProperties}
      aria-label={`${project.name} 图标`}
      title={project.name}
    >
      {imageIcon ? <img src={icon} alt="" /> : textIcon}
    </span>
  )
}
