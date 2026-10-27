import { z } from 'zod'

export const deviceSchema = z.object({
  id: z.uuid().optional(),
  platform: z.enum(['macos', 'ios']),
  name: z.string().trim().min(1).max(100),
  publicKey: z.string().min(16).max(4096),
  appVersion: z.string().trim().min(1).max(50),
  protocolVersion: z.number().int().positive().max(1000)
})

export const startEmailSchema = z.object({
  email: z.email().max(254).transform((value) => value.trim().toLowerCase())
})

export const verifyEmailSchema = z.object({
  challengeId: z.uuid(),
  code: z.string().regex(/^\d{6}$/u),
  device: deviceSchema
})

const googleIdTokenSchema = z.object({
  idToken: z.string().min(20)
}).strict()

const googleAuthorizationCodeSchema = z.object({
  authorizationCode: z.string().min(10).max(4096),
  clientId: z.string().trim().regex(/^\d+-[a-z0-9-]+\.apps\.googleusercontent\.com$/iu).max(255),
  codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/u),
  redirectUri: z.url().max(2048).refine((value) => {
    const url = new URL(value)
    return url.protocol === 'http:'
      && url.hostname === '127.0.0.1'
      && Boolean(url.port)
      && url.pathname === '/'
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
  }, 'Google OAuth 回调地址必须是带随机端口的本机 loopback 地址。')
}).strict()

export const googleIdentitySchema = z.union([
  googleIdTokenSchema,
  googleAuthorizationCodeSchema
])

export const googleSignInSchema = z.union([
  googleIdTokenSchema.extend({ device: deviceSchema }),
  googleAuthorizationCodeSchema.extend({ device: deviceSchema })
])

export const refreshSchema = z.object({
  refreshToken: z.string().min(20)
})

export const enrollmentSchema = z.object({
  deviceId: z.uuid()
})

export const createProjectShareSchema = z.object({
  localProjectId: z.uuid(),
  executionHostId: z.uuid()
}).strict()

export const updateProjectExecutionHostSchema = z.object({
  executionHostId: z.uuid()
}).strict()

export const createProjectInvitationSchema = z.object({
  email: z.email().max(254).transform((value) => value.trim().toLowerCase())
}).strict()

export const acceptProjectInvitationSchema = z.object({
  token: z.string().regex(/^fuddy_invite_[A-Za-z0-9_-]{43}$/u)
}).strict()

export const completeProjectDeviceGrantSchema = z.object({
  wrappedProjectKey: z.string().min(16).max(16384),
  keyEpoch: z.number().int().positive().max(1_000_000)
}).strict()

export const publishProjectEventSchema = z.object({
  eventId: z.uuid(),
  keyEpoch: z.number().int().positive().max(1_000_000),
  kind: z.enum(['snapshot', 'chat', 'message', 'settings']),
  envelope: z.object({
    algorithm: z.literal('A256GCM'),
    keyId: z.string().regex(/^[A-Za-z0-9_-]{16}$/u),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{16}$/u),
    ciphertext: z.string().regex(/^[A-Za-z0-9_-]{24,60000}$/u)
  }).strict()
}).strict()

export const beginProjectBaselineSchema = z.object({
  baselineId: z.uuid(),
  keyEpoch: z.number().int().positive().max(1_000_000),
  chunkCount: z.number().int().positive().max(2_000)
}).strict()

export const putProjectBaselineChunkSchema = z.object({
  index: z.number().int().nonnegative().max(1_999),
  envelope: publishProjectEventSchema.shape.envelope
}).strict()

export const registerProjectChatSchema = z.object({
  runId: z.uuid(),
  createdByUserId: z.uuid().nullable(),
  visibility: z.enum(['draft', 'published'])
}).strict()

export const submitProjectCommandSchema = z.object({
  commandId: z.uuid(),
  type: z.enum(['create-chat', 'send-message', 'cancel-turn', 'stop-turn', 'rename-chat', 'archive-chat']),
  runId: z.uuid().nullable(),
  requestId: z.uuid().nullable(),
  keyEpoch: z.number().int().positive().max(1_000_000),
  envelope: publishProjectEventSchema.shape.envelope
}).strict().superRefine((input, ctx) => {
  if (input.type === 'create-chat' && input.runId !== null) {
    ctx.addIssue({ code: 'custom', message: '新建 Chat 不应指定已有 Chat。' })
  }
  if (input.type !== 'create-chat' && input.runId === null) {
    ctx.addIssue({ code: 'custom', message: '此操作需要指定 Chat。' })
  }
  if (['send-message', 'cancel-turn', 'stop-turn'].includes(input.type) && !input.requestId) {
    ctx.addIssue({ code: 'custom', message: '此操作需要消息请求 ID。' })
  }
  if (!['send-message', 'cancel-turn', 'stop-turn'].includes(input.type) && input.requestId) {
    ctx.addIssue({ code: 'custom', message: '此操作不能指定消息请求 ID。' })
  }
})

export const completeProjectCommandSchema = z.object({
  status: z.enum(['completed', 'failed']),
  resultRunId: z.uuid().nullable(),
  errorCode: z.string().trim().min(1).max(100).nullable()
}).strict()

export const completeEnrollmentSchema = z.object({
  wrappedSpaceKey: z.string().min(16).max(16384),
  keyVersion: z.number().int().positive().max(1_000_000)
})

export const relayBindingSchema = z.object({
  relayUrl: z.url().max(2048)
    .refine((value) => {
      const url = new URL(value)
      return !url.username && !url.password && !url.search && !url.hash
    }, 'Relay URL 不能包含凭证、查询参数或片段。')
    .transform((value) => {
      const url = new URL(value)
      const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/u, '')
      return `${url.origin}${pathname}`
    }),
  relayAccountId: z.string().trim().min(1).max(200),
  bindingProof: z.string().trim().min(20).max(500)
})

export const resendWebhookSchema = z.object({
  type: z.enum([
    'email.sent',
    'email.delivered',
    'email.delivery_delayed',
    'email.failed',
    'email.bounced',
    'email.complained',
    'email.suppressed'
  ]),
  created_at: z.iso.datetime({ offset: true }),
  data: z.object({
    email_id: z.string().trim().min(1).max(200)
  }).loose()
})
