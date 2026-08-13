import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConnectorRuntime } from '../connectors/connector-runtime'
import type { CredentialVault } from './credential-vault'
import { AppDatabase } from './database'
import { createTestDatabase } from '../test-support/project-fixtures'
import { DailyBriefingService } from './daily-briefing'
import { DecisionRemediationService } from './decision-remediation'
import { MorningBriefingService } from './morning-briefing'
import type { AgentRuntime } from './pi-runtime'

const enabled = process.env.RUN_MORNING_BRIEFING_SMOKE === '1'

describe.skipIf(!enabled)('live morning briefing regeneration', () => {
  it('refreshes production metrics and linked GitHub remediation evidence', async () => {
    const databasePath = join(
      homedir(),
      'Library',
      'Application Support',
      'ai-native-project-agent',
      'project-agent.sqlite'
    )
    const database = createTestDatabase(databasePath)
    const runtime: AgentRuntime = {
      isConfigured: () => false,
      run: async () => '',
      runStream: async () => ''
    }
    try {
      const connectorRuntime = new ConnectorRuntime(database, {} as CredentialVault)
      const dailyBriefingService = new DailyBriefingService(database, connectorRuntime, runtime)
      const remediationService = new DecisionRemediationService(database)
      const morningBriefingService = new MorningBriefingService(
        database,
        dailyBriefingService,
        runtime,
        undefined,
        undefined,
        remediationService
      )

      const result = await morningBriefingService.generate()
      const onboardingRemediation = database.listDecisionRemediations()
        .find((item) => item.sourceRef === 'https://github.com/LIU9293/shopmy/pull/351')

      expect(result.briefing.status).toBe('completed')
      expect(result.briefing.body).toContain('PR #351')
      expect(result.briefing.body).not.toContain('检查最老入驻事项的阻塞原因')
      expect(onboardingRemediation).toBeDefined()
      expect(['review_required', 'ready_to_merge', 'merged_awaiting_deploy', 'blocked', 'in_progress'])
        .toContain(onboardingRemediation?.state)
    } finally {
      database.close()
    }
  }, 60_000)
})
