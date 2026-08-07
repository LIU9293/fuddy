import type { ConnectorKind, DecisionKind, EvidenceRef, Urgency } from '../../shared/contracts'

export interface ConnectorProbe {
  summary: string
  evidenceRefs: EvidenceRef[]
}

export interface ConnectorSignal {
  fingerprint: string
  kind: DecisionKind
  title: string
  summary: string
  impact: string
  urgency: Urgency
  confidence: number
  suggestedActions: string[]
  evidenceRefs: EvidenceRef[]
  source: string
}

export interface ConnectorCollection extends ConnectorProbe {
  signal: ConnectorSignal | null
  resolvedSignals?: Array<{
    fingerprint: string
    summary: string
    evidenceRefs: EvidenceRef[]
  }>
  data?: Record<string, unknown>
}

export interface ConnectorContext {
  config: Record<string, string | number | boolean>
  credentialRef: string | null
}

export interface ConnectorAdapter {
  readonly kind: ConnectorKind
  test(context: ConnectorContext): Promise<ConnectorProbe>
  collect(context: ConnectorContext): Promise<ConnectorCollection>
}
