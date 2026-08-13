export function buildAgentStoragePolicy(input: {
  workingDirectory: string
  workspaceRoots: string[]
  filesDirectory: string
}): string {
  const roots = input.workspaceRoots.length > 0
    ? input.workspaceRoots.map((root, index) => `${index + 1}. ${root}${root === input.workingDirectory ? '（主 Workspace）' : ''}`).join('\n')
    : `1. ${input.workingDirectory}（主 Workspace）`
  return `项目主工作目录：${input.workingDirectory}
允许访问的 Workspace Roots：
${roots}
项目文件空间：${input.filesDirectory}

文件存放规则：
- 源代码、代码配置、随产品构建或发布的资源，以及需要进入版本控制的仓库文档，写入对应 Workspace。
- Marketing、运营、研究、报告、账号资料、品牌资料和宣传素材等代码无关产物，写入项目文件空间。
- 先搜索并复用已有文件；不要因为找不到上下文就要求用户重复提供 App 已配置的项目路径。
- 新建或修改项目文件空间中的产物后，在最终回复中列出相对路径，方便 Fuddy 登记和展示。
- 不要把凭证、Token、登录信息或其他秘密写入 Workspace 或项目文件空间。`
}
