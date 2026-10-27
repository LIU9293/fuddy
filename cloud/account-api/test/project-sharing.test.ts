import { SELF, env } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import {
  beginProjectBaseline, commitProjectBaseline, listProjectBaselineChunks,
  listProjectBaselines, listProjectEvents, publishProjectEvent, putProjectBaselineChunk
} from '../src/index'
import type { ProjectRelayAdministrationBinding } from '../../relay/src/administration-contract'

async function post(path: string, body: unknown, accessToken?: string): Promise<Response> {
  return SELF.fetch(`https://account.test${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cf-connecting-ip': '203.0.113.50',
      ...(path.startsWith('/v1/project-shares') || path === '/v1/project-invitations/accept'
        ? { 'X-Fuddy-Project-Sharing-Version': '1' } : {}),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {})
    },
    body: JSON.stringify(body)
  })
}

async function request(path: string, method: 'GET' | 'DELETE', accessToken: string): Promise<Response> {
  return SELF.fetch(`https://account.test${path}`, {
    method,
    headers: { authorization: `Bearer ${accessToken}`,
      'X-Fuddy-Project-Sharing-Version': '1' }
  })
}

async function signIn(email: string) {
  const start = await post('/v1/auth/email/start', { email })
  const challenge = await start.json<{ challengeId: string; debugCode: string }>()
  const verify = await post('/v1/auth/email/verify', {
    challengeId: challenge.challengeId,
    code: challenge.debugCode,
    device: {
      id: crypto.randomUUID(), platform: 'macos', name: email,
      publicKey: 'test-public-key-material', appVersion: '0.0.7', protocolVersion: 5
    }
  })
  expect(verify.status).toBe(200)
  return verify.json<{ user: { id: string }; device: { hostId: string }; session: { accessToken: string } }>()
}

async function registerShare(localProjectId: string, executionHostId: string, token: string): Promise<string> {
  const response = await post('/v1/project-shares', { localProjectId, executionHostId }, token)
  expect(response.status).toBe(201)
  return (await response.json<{ projectShare: { projectId: string } }>()).projectShare.projectId
}

describe('project share authorization', () => {
  it('isolates encrypted attachments by project, device and request until publication', async () => {
    const owner = await signIn('attachment-owner@example.com')
    const member = await signIn('attachment-member@example.com')
    const stranger = await signIn('attachment-stranger@example.com')
    const projectId = await registerShare(crypto.randomUUID(), owner.device.hostId, owner.session.accessToken)
    expect((await SELF.fetch('https://account.test/v1/project-shares', {
      headers: { authorization: `Bearer ${owner.session.accessToken}` }
    })).status).toBe(426)
    const otherProjectId = await registerShare(crypto.randomUUID(), owner.device.hostId, owner.session.accessToken)
    const invitation = (await (await post(`/v1/project-shares/${projectId}/invitations`, {
      email: 'attachment-member@example.com'
    }, owner.session.accessToken)).json<any>()).invitation
    await post('/v1/project-invitations/accept', { token: invitation.token }, member.session.accessToken)
    const grant = (await (await post(`/v1/project-shares/${projectId}/device-grant`, {},
      member.session.accessToken)).json<any>()).grant
    await post(`/v1/project-shares/${projectId}/device-grants/${grant.id}/complete`, {
      wrappedProjectKey: 'wrapped-project-key-material-long', keyEpoch: 1
    }, owner.session.accessToken)
    const runId = crypto.randomUUID()
    await post(`/v1/project-shares/${projectId}/chats`, {
      runId, createdByUserId: owner.user.id, visibility: 'published'
    }, owner.session.accessToken)
    const requestId = crypto.randomUUID()
    const attachmentId = crypto.randomUUID()
    const bytes = new Uint8Array([80, 65, 69, 50, ...Array.from({ length: 40 }, (_, i) => i + 1)])
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((byte) => byte.toString(16).padStart(2, '0')).join('')
    const put = (token: string, project: string, id = attachmentId, run = runId,
      requested = requestId) => SELF.fetch(`https://account.test/v1/project-shares/${project}/attachments/${id}`, {
        method: 'PUT', headers: {
          authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream',
          'Content-Length': String(bytes.byteLength), 'X-Content-SHA256': hash,
          'X-Project-Key-Epoch': '1', 'X-Project-Run-Id': run,
          'X-Project-Request-Id': requested, 'X-Project-Attachment-Kind': 'input',
          'X-Fuddy-Project-Sharing-Version': '1'
        }, body: bytes
      })
    expect((await put(stranger.session.accessToken, projectId)).status).toBe(404)
    expect((await put(member.session.accessToken, otherProjectId)).status).toBe(404)
    expect((await put(member.session.accessToken, projectId, attachmentId, crypto.randomUUID())).status).toBe(404)
    expect((await put(member.session.accessToken, projectId)).status).toBe(201)
    expect((await put(member.session.accessToken, projectId)).status).toBe(200)
    expect((await request(`/v1/project-shares/${projectId}/attachments/${attachmentId}`,
      'GET', stranger.session.accessToken)).status).toBe(404)
    const ownerDownload = await request(`/v1/project-shares/${projectId}/attachments/${attachmentId}`,
      'GET', owner.session.accessToken)
    expect(ownerDownload.status).toBe(200)
    expect(new Uint8Array(await ownerDownload.arrayBuffer())).toEqual(bytes)
    const memberDownload = await request(`/v1/project-shares/${projectId}/attachments/${attachmentId}`,
      'GET', member.session.accessToken)
    expect(memberDownload.status).toBe(200)
    expect((await request(`/v1/project-shares/${otherProjectId}/attachments/${attachmentId}`,
      'GET', owner.session.accessToken)).status).toBe(404)
    expect((await env.ACCOUNT_DB.prepare(
      'SELECT status FROM project_attachments WHERE attachment_id = ?'
    ).bind(attachmentId).first<{ status: string }>())?.status).toBe('pending')
    await post(`/v1/project-shares/${projectId}/host-heartbeat`, {}, owner.session.accessToken)
    const commandId = crypto.randomUUID()
    const envelope = { algorithm: 'A256GCM', keyId: 'keyidentifier123',
      nonce: '0123456789abcdef', ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }
    expect((await post(`/v1/project-shares/${projectId}/commands`, {
      commandId, type: 'send-message', runId, requestId, keyEpoch: 1, envelope
    }, member.session.accessToken)).status).toBe(201)
    expect((await post(`/v1/project-shares/${projectId}/commands/${commandId}/claim`, {},
      owner.session.accessToken)).status).toBe(200)
    expect((await post(`/v1/project-shares/${projectId}/commands/${commandId}/complete`, {
      status: 'failed', resultRunId: runId, errorCode: 'execution_failed'
    }, owner.session.accessToken)).status).toBe(204)
    expect((await env.ACCOUNT_DB.prepare(
      'SELECT status FROM project_attachments WHERE attachment_id = ?'
    ).bind(attachmentId).first<{ status: string }>())?.status).toBe('published')
    expect((await request(`/v1/project-shares/${projectId}/members/${member.user.id}`,
      'DELETE', owner.session.accessToken)).status).toBe(204)
    const rotated = await SELF.fetch(
      `https://account.test/v1/project-shares/${projectId}/attachments/${attachmentId}`, {
        method: 'PUT', headers: {
          authorization: `Bearer ${owner.session.accessToken}`,
          'X-Fuddy-Project-Sharing-Version': '1', 'Content-Type': 'application/octet-stream',
          'Content-Length': String(bytes.byteLength), 'X-Content-SHA256': hash,
          'X-Project-Key-Epoch': '2', 'X-Project-Run-Id': runId,
          'X-Project-Attachment-Kind': 'artifact'
        }, body: bytes
      }
    )
    expect(rotated.status).toBe(201)
    expect((await request(`/v1/project-shares/${projectId}/attachments/${attachmentId}`,
      'GET', owner.session.accessToken)).headers.get('X-Project-Key-Epoch')).toBe('2')
    expect((await request(`/v1/project-shares/${projectId}/attachments/${attachmentId}`,
      'GET', member.session.accessToken)).status).toBe(404)
  })

  it('binds member commands to authenticated identity, host, permissions and a short lease', async () => {
    const owner = await signIn('command-owner@example.com')
    const member = await signIn('command-member@example.com')
    const stranger = await signIn('command-stranger@example.com')
    const projectId = await registerShare(crypto.randomUUID(), owner.device.hostId, owner.session.accessToken)
    const invitation = (await (await post(`/v1/project-shares/${projectId}/invitations`, {
      email: 'command-member@example.com'
    }, owner.session.accessToken)).json<any>()).invitation
    await post('/v1/project-invitations/accept', { token: invitation.token }, member.session.accessToken)
    const grant = (await (await post(`/v1/project-shares/${projectId}/device-grant`, {},
      member.session.accessToken)).json<any>()).grant
    expect((await post(`/v1/project-shares/${projectId}/device-grants/${grant.id}/complete`, {
      wrappedProjectKey: 'wrapped-project-key-material-long', keyEpoch: 1
    }, owner.session.accessToken)).status).toBe(204)
    const runId = crypto.randomUUID()
    expect((await post(`/v1/project-shares/${projectId}/chats`, {
      runId, createdByUserId: owner.user.id, visibility: 'published'
    }, owner.session.accessToken)).status).toBe(200)
    expect((await post(`/v1/project-shares/${projectId}/host-heartbeat`, {},
      owner.session.accessToken)).status).toBe(204)
    const envelope = { algorithm: 'A256GCM', keyId: 'keyidentifier123',
      nonce: '0123456789abcdef', ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }
    const commandId = crypto.randomUUID()
    const requestId = crypto.randomUUID()
    const input = { commandId, type: 'send-message', runId, requestId, keyEpoch: 1, envelope }
    expect((await post(`/v1/project-shares/${projectId}/commands`, input,
      stranger.session.accessToken)).status).toBe(404)
    const submitted = await post(`/v1/project-shares/${projectId}/commands`, input, member.session.accessToken)
    expect(submitted.status).toBe(201)
    expect((await submitted.json<any>()).command).toMatchObject({
      actorUserId: member.user.id, targetHostId: owner.device.hostId, status: 'pending'
    })
    expect((await post(`/v1/project-shares/${projectId}/commands`, input,
      member.session.accessToken)).status).toBe(200)
    const mine = await request(`/v1/project-shares/${projectId}/commands?mine=1`,
      'GET', member.session.accessToken)
    expect((await mine.json<any>()).commands.map((command: any) => command.commandId)).toEqual([commandId])
    expect((await request(`/v1/project-shares/${projectId}/commands?mine=1`,
      'GET', stranger.session.accessToken)).status).toBe(404)
    const listed = await request(`/v1/project-shares/${projectId}/commands`, 'GET', owner.session.accessToken)
    expect((await listed.json<any>()).commands).toMatchObject([{ commandId }])
    expect((await request(`/v1/project-shares/${projectId}/commands`,
      'GET', member.session.accessToken)).status).toBe(404)
    const claim = await post(`/v1/project-shares/${projectId}/commands/${commandId}/claim`, {},
      owner.session.accessToken)
    expect((await claim.json<any>()).command.status).toBe('claimed')
    expect((await post(`/v1/project-shares/${projectId}/commands/${commandId}/renew`, {},
      owner.session.accessToken)).status).toBe(200)
    expect((await post(`/v1/project-shares/${projectId}/commands/${commandId}/complete`, {
      status: 'completed', resultRunId: runId, errorCode: null
    }, owner.session.accessToken)).status).toBe(204)
    const completed = await request(`/v1/project-shares/${projectId}/commands/${commandId}`,
      'GET', member.session.accessToken)
    expect((await completed.json<any>()).command.status).toBe('completed')
    expect((await post(`/v1/project-shares/${projectId}/commands`, {
      ...input, commandId: crypto.randomUUID()
    }, member.session.accessToken)).status).toBe(409)
    expect((await post(`/v1/project-shares/${projectId}/commands`, {
      ...input, commandId: crypto.randomUUID(), type: 'rename-chat', requestId: null
    }, member.session.accessToken)).status).toBe(403)

    const pendingId = crypto.randomUUID()
    expect((await post(`/v1/project-shares/${projectId}/commands`, {
      commandId: pendingId, type: 'create-chat', runId: null,
      requestId: null, keyEpoch: 1, envelope
    }, member.session.accessToken)).status).toBe(201)
    await env.ACCOUNT_DB.prepare("UPDATE project_commands SET created_at = datetime('now', '-2 minutes') WHERE command_id = ?")
      .bind(pendingId).run()
    expect((await post(`/v1/project-shares/${projectId}/commands/${pendingId}/claim`, {},
      owner.session.accessToken)).status).toBe(409)
    const stale = await request(`/v1/project-shares/${projectId}/commands/${pendingId}`,
      'GET', member.session.accessToken)
    expect((await stale.json<any>()).command).toMatchObject({
      status: 'interrupted', errorCode: 'execution_host_offline'
    })
    const claimedId = crypto.randomUUID()
    expect((await post(`/v1/project-shares/${projectId}/commands`, {
      commandId: claimedId, type: 'create-chat', runId: null,
      requestId: null, keyEpoch: 1, envelope
    }, member.session.accessToken)).status).toBe(201)
    expect((await post(`/v1/project-shares/${projectId}/commands/${claimedId}/claim`, {},
      owner.session.accessToken)).status).toBe(200)
    await request(`/v1/project-shares/${projectId}/members/${member.user.id}`,
      'DELETE', owner.session.accessToken)
    expect((await post(`/v1/project-shares/${projectId}/commands/${pendingId}/claim`, {},
      owner.session.accessToken)).status).toBe(409)
    expect((await post(`/v1/project-shares/${projectId}/commands/${claimedId}/renew`, {},
      owner.session.accessToken)).status).toBe(409)
    const resultRunId = crypto.randomUUID()
    expect((await post(`/v1/project-shares/${projectId}/commands/${claimedId}/complete`, {
      status: 'completed', resultRunId, errorCode: null
    }, owner.session.accessToken)).status).toBe(409)
    expect(await env.ACCOUNT_DB.prepare('SELECT 1 FROM project_chats WHERE run_id = ?')
      .bind(resultRunId).first()).toBeNull()
  })

  it('restricts baseline publication to the execution Mac and replay to granted devices', async () => {
    const owner = await signIn('baseline-owner@example.com')
    const member = await signIn('baseline-member@example.com')
    const projectId = await registerShare(crypto.randomUUID(), owner.device.hostId, owner.session.accessToken)
    const baselineId = crypto.randomUUID()
    const invitation = (await (await post(`/v1/project-shares/${projectId}/invitations`, {
      email: 'baseline-member@example.com'
    }, owner.session.accessToken)).json<any>()).invitation
    await post('/v1/project-invitations/accept', { token: invitation.token }, member.session.accessToken)
    const baseline = { baselineId, projectId, sourceDeviceId: crypto.randomUUID(),
      keyEpoch: 1, watermark: 7, chunkCount: 1, createdAt: new Date().toISOString() }
    const envelope = { algorithm: 'A256GCM' as const, keyId: 'keyidentifier123',
      nonce: '0123456789abcdef', ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }
    const chunk = { baselineId, index: 0, envelope }
    const relay: ProjectRelayAdministrationBinding = {
      appendProjectEvent: vi.fn(), listProjectEvents: vi.fn(),
      beginProjectBaseline: vi.fn(async () => baseline),
      putProjectBaselineChunk: vi.fn(async () => 'ok' as const),
      commitProjectBaseline: vi.fn(async () => 'ok' as const),
      listProjectBaselines: vi.fn(async () => [baseline]),
      listProjectBaselineChunks: vi.fn(async () => [chunk])
    }
    const make = (method: string, suffix: string, token: string, body?: unknown) => new Request(
      `https://account.test/v1/project-shares/${projectId}/${suffix}`, {
        method, headers: { authorization: `Bearer ${token}` },
        ...(body ? { body: JSON.stringify(body) } : {})
      }
    )
    await expect(beginProjectBaseline(make('POST', 'baselines', member.session.accessToken,
      { baselineId, keyEpoch: 1, chunkCount: 1 }), env, projectId, relay))
      .rejects.toMatchObject({ status: 404 })
    expect((await beginProjectBaseline(make('POST', 'baselines', owner.session.accessToken,
      { baselineId, keyEpoch: 1, chunkCount: 1 }), env, projectId, relay)).status).toBe(201)
    expect((await putProjectBaselineChunk(make('PUT', `baselines/${baselineId}/chunks`, owner.session.accessToken,
      { index: 0, envelope }), env, projectId, baselineId, relay)).status).toBe(204)
    expect((await commitProjectBaseline(make('POST', `baselines/${baselineId}/commit`, owner.session.accessToken),
      env, projectId, baselineId, relay)).status).toBe(204)
    await expect(listProjectBaselines(make('GET', 'baselines', member.session.accessToken),
      env, projectId, relay)).rejects.toMatchObject({ status: 403 })
    const grant = (await (await post(`/v1/project-shares/${projectId}/device-grant`, {},
      member.session.accessToken)).json<any>()).grant
    await post(`/v1/project-shares/${projectId}/device-grants/${grant.id}/complete`, {
      wrappedProjectKey: 'wrapped-project-key-material-long', keyEpoch: 1
    }, owner.session.accessToken)
    expect((await (await listProjectBaselines(make('GET', 'baselines', member.session.accessToken),
      env, projectId, relay)).json<any>()).baselines).toEqual([baseline])
    expect((await (await listProjectBaselineChunks(make('GET', `baselines/${baselineId}/chunks`,
      member.session.accessToken), env, projectId, baselineId, relay)).json<any>()).chunks)
      .toEqual([chunk])
  })

  it('permits registered owner Macs to publish and only an authorized member device to replay', async () => {
    const owner = await signIn('events-owner@example.com')
    await env.ACCOUNT_DB.prepare('DELETE FROM auth_email_cooldowns WHERE email = ?')
      .bind('events-owner@example.com').run()
    await env.ACCOUNT_DB.prepare("UPDATE auth_challenges SET created_at = datetime('now', '-2 minutes') WHERE email = ?")
      .bind('events-owner@example.com').run()
    const ownerOtherHost = await signIn('events-owner@example.com')
    const member = await signIn('events-member@example.com')
    await env.ACCOUNT_DB.prepare('DELETE FROM auth_email_cooldowns WHERE email = ?')
      .bind('events-member@example.com').run()
    await env.ACCOUNT_DB.prepare("UPDATE auth_challenges SET created_at = datetime('now', '-2 minutes') WHERE email = ?")
      .bind('events-member@example.com').run()
    const memberOtherDevice = await signIn('events-member@example.com')
    const stranger = await signIn('events-stranger@example.com')
    const projectId = await registerShare(crypto.randomUUID(), owner.device.hostId, owner.session.accessToken)
    const otherProjectId = await registerShare(crypto.randomUUID(), stranger.device.hostId, stranger.session.accessToken)
    const invitation = (await (await post(`/v1/project-shares/${projectId}/invitations`, {
      email: 'events-member@example.com'
    }, owner.session.accessToken)).json<any>()).invitation
    await post('/v1/project-invitations/accept', { token: invitation.token }, member.session.accessToken)

    const event = {
      eventId: crypto.randomUUID(), keyEpoch: 1, kind: 'chat' as const,
      envelope: { algorithm: 'A256GCM' as const, keyId: 'keyidentifier123',
        nonce: '0123456789abcdef', ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }
    }
    const appendProjectEvent = vi.fn(async (id: string, input: any) => ({
      ...input, projectId: id, sequence: 1, createdAt: new Date().toISOString()
    }))
    const listProjectEventsStub = vi.fn(async (id: string) => [{
      ...event, projectId: id, actorUserId: owner.user.id,
      sourceDeviceId: 'owner-device', sequence: 1, createdAt: new Date().toISOString()
    }])
    const relay: ProjectRelayAdministrationBinding = {
      appendProjectEvent, listProjectEvents: listProjectEventsStub,
      beginProjectBaseline: vi.fn(), putProjectBaselineChunk: vi.fn(),
      commitProjectBaseline: vi.fn(), listProjectBaselines: vi.fn(),
      listProjectBaselineChunks: vi.fn()
    }
    const publish = (token: string, id = projectId, payload: unknown = event) => publishProjectEvent(
      new Request(`https://account.test/v1/project-shares/${id}/events`, {
        method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(payload)
      }), env, id, relay
    )
    const replay = (token: string, id = projectId) => listProjectEvents(
      new Request(`https://account.test/v1/project-shares/${id}/events?after=0&limit=20`, {
        headers: { authorization: `Bearer ${token}` }
      }), env, id, relay
    )
    await expect(publish(member.session.accessToken)).rejects.toMatchObject({ status: 404 })
    await expect(publish(stranger.session.accessToken)).rejects.toMatchObject({ status: 404 })
    await expect(publish(ownerOtherHost.session.accessToken)).rejects.toMatchObject({ status: 403 })
    await expect(replay(stranger.session.accessToken)).rejects.toMatchObject({ status: 404 })
    await expect(replay(member.session.accessToken)).rejects.toMatchObject({ status: 403 })
    expect(appendProjectEvent).not.toHaveBeenCalled()
    expect(listProjectEventsStub).not.toHaveBeenCalled()
    const published = await publish(owner.session.accessToken)
    expect(published.status).toBe(201)
    expect(appendProjectEvent).toHaveBeenCalledWith(projectId, expect.objectContaining({
      eventId: event.eventId, actorUserId: owner.user.id, sourceDeviceId: expect.any(String)
    }))
    expect((await post(`/v1/project-shares/${projectId}/publishers/self`, {},
      member.session.accessToken)).status).toBe(404)
    expect((await post(`/v1/project-shares/${projectId}/publishers/self`, {},
      ownerOtherHost.session.accessToken)).status).toBe(200)
    expect((await publish(ownerOtherHost.session.accessToken, projectId,
      { ...event, eventId: crypto.randomUUID() })).status).toBe(201)
    const ownerGrant = (await (await post(`/v1/project-shares/${projectId}/device-grant`, {},
      ownerOtherHost.session.accessToken)).json<any>()).grant
    expect(ownerGrant.status).toBe('pending')
    const ownerPending = await request(`/v1/project-shares/${projectId}/device-grants`,
      'GET', owner.session.accessToken)
    expect((await ownerPending.json<any>()).grants).toMatchObject([
      { id: ownerGrant.id, userId: owner.user.id }
    ])
    expect((await post(`/v1/project-shares/${projectId}/device-grants/${ownerGrant.id}/complete`, {
      wrappedProjectKey: 'wrapped-project-key-material-long', keyEpoch: 1
    }, owner.session.accessToken)).status).toBe(204)
    expect((await (await request(`/v1/project-shares/${projectId}/device-grant`,
      'GET', ownerOtherHost.session.accessToken)).json<any>()).grant.status).toBe('active')
    const publishers = await request(`/v1/project-shares/${projectId}/publishers`, 'GET', member.session.accessToken)
    expect((await publishers.json<any>()).publishers).toHaveLength(2)
    await expect(publish(owner.session.accessToken, projectId, { ...event, keyEpoch: 2 }))
      .rejects.toMatchObject({ status: 409 })
    expect((await replay(owner.session.accessToken)).status).toBe(200)

    const grant = (await (await post(`/v1/project-shares/${projectId}/device-grant`, {}, member.session.accessToken)).json<any>()).grant
    const switched = await post(`/v1/project-shares/${projectId}/execution-host`, {
      executionHostId: ownerOtherHost.device.hostId
    }, owner.session.accessToken)
    expect(switched.status).toBe(200)
    expect((await switched.json<any>()).projectShare).toMatchObject({
      executionHostId: ownerOtherHost.device.hostId,
      keyAuthorityHostId: owner.device.hostId
    })
    expect((await request(`/v1/project-shares/${projectId}/device-grants`, 'GET',
      owner.session.accessToken)).status).toBe(200)
    expect((await post(`/v1/project-shares/${projectId}/device-grants/${grant.id}/complete`, {
      wrappedProjectKey: 'wrapped-project-key-material-long', keyEpoch: 1
    }, owner.session.accessToken)).status).toBe(204)
    const allowed = await replay(member.session.accessToken)
    expect(allowed.status).toBe(200)
    expect((await allowed.json<any>()).events).toHaveLength(1)
    await expect(replay(memberOtherDevice.session.accessToken)).rejects.toMatchObject({ status: 403 })
    await expect(replay(member.session.accessToken, otherProjectId)).rejects.toMatchObject({ status: 404 })
    await request(`/v1/project-shares/${projectId}/members/${member.user.id}`, 'DELETE', owner.session.accessToken)
    const rotated = await request(`/v1/project-shares/${projectId}`, 'GET', owner.session.accessToken)
    expect((await rotated.json<any>()).projectShare).toMatchObject({
      keyEpoch: 2, keyAuthorityHostId: ownerOtherHost.device.hostId
    })
    await expect(replay(member.session.accessToken)).rejects.toMatchObject({ status: 404 })
    await expect(publish(owner.session.accessToken)).rejects.toMatchObject({ status: 409 })
  })

  it('does not duplicate membership or permission changes when one invitation is accepted concurrently', async () => {
    const owner = await signIn('parallel-share-owner@example.com')
    const invited = await signIn('parallel-share-member@example.com')
    const projectId = await registerShare(crypto.randomUUID(), owner.device.hostId, owner.session.accessToken)
    const invitation = (await (await post(`/v1/project-shares/${projectId}/invitations`, {
      email: 'parallel-share-member@example.com'
    }, owner.session.accessToken)).json<any>()).invitation
    const accepted = await Promise.all(Array.from({ length: 8 }, () =>
      post('/v1/project-invitations/accept', { token: invitation.token }, invited.session.accessToken)))
    expect(accepted.every((response) => [200, 201].includes(response.status))).toBe(true)
    const share = await request(`/v1/project-shares/${projectId}`, 'GET', owner.session.accessToken)
    expect((await share.json<any>()).projectShare.permissionRevision).toBe(2)
    const members = await request(`/v1/project-shares/${projectId}/members`, 'GET', owner.session.accessToken)
    expect((await members.json<any>()).members).toHaveLength(1)
  })

  it('binds a project to its owner and requires the current Mac as execution host', async () => {
    const owner = await signIn('share-owner@example.com')
    const stranger = await signIn('share-stranger@example.com')
    const localProjectId = crypto.randomUUID()
    const badHost = await post('/v1/project-shares', {
      localProjectId, executionHostId: stranger.device.hostId
    }, owner.session.accessToken)
    expect(badHost.status).toBe(403)
    const created = await post('/v1/project-shares', {
      localProjectId, executionHostId: owner.device.hostId
    }, owner.session.accessToken)
    expect(created.status).toBe(201)
    const projectId = (await created.json<any>()).projectShare.projectId as string
    expect(projectId).not.toBe(localProjectId)
    expect((await (await request(`/v1/project-shares/${projectId}`, 'GET', owner.session.accessToken)).json<any>()).projectShare).toMatchObject({
      projectId, localProjectId, role: 'owner', permissionRevision: 1, keyEpoch: 1
    })
    expect((await post(`/v1/project-shares/${projectId}/execution-host`, {
      executionHostId: stranger.device.hostId
    }, owner.session.accessToken)).status).toBe(404)
    const unchanged = await post(`/v1/project-shares/${projectId}/execution-host`, {
      executionHostId: owner.device.hostId
    }, owner.session.accessToken)
    expect((await unchanged.json<any>()).projectShare.permissionRevision).toBe(1)
    expect((await post('/v1/project-shares', {
      localProjectId, executionHostId: owner.device.hostId
    }, owner.session.accessToken)).status).toBe(200)
    expect((await request(`/v1/project-shares/${projectId}`, 'GET', stranger.session.accessToken)).status).toBe(404)
    const strangerShareId = await registerShare(localProjectId, stranger.device.hostId, stranger.session.accessToken)
    expect(strangerShareId).not.toBe(projectId)
    const strangerList = await request('/v1/project-shares', 'GET', stranger.session.accessToken)
    expect((await strangerList.json<any>()).projectShares).toMatchObject([{ projectId: strangerShareId }])
  })

  it('accepts only the invited account, then revokes member access and rotates authorization epoch', async () => {
    const owner = await signIn('invite-owner@example.com')
    const invited = await signIn('invite-member@example.com')
    const stranger = await signIn('invite-stranger@example.com')
    const projectId = await registerShare(crypto.randomUUID(), owner.device.hostId, owner.session.accessToken)
    const inviteResponse = await post(`/v1/project-shares/${projectId}/invitations`, {
      email: 'INVITE-MEMBER@example.com'
    }, owner.session.accessToken)
    expect(inviteResponse.status).toBe(201)
    const invitation = (await inviteResponse.json<any>()).invitation
    expect(invitation.email).toBe('invite-member@example.com')
    expect(invitation.token).toMatch(/^fuddy_invite_/u)
    const saved = await env.ACCOUNT_DB.prepare(
      'SELECT token_hash AS tokenHash FROM project_invitations WHERE id = ?'
    ).bind(invitation.id).first<{ tokenHash: string }>()
    expect(saved?.tokenHash).not.toBe(invitation.token)
    expect((await post('/v1/project-invitations/accept', {
      token: invitation.token
    }, stranger.session.accessToken)).status).toBe(403)
    expect((await post('/v1/project-invitations/accept', {
      token: invitation.token
    }, invited.session.accessToken)).status).toBe(201)
    expect((await post('/v1/project-invitations/accept', {
      token: invitation.token
    }, invited.session.accessToken)).status).toBe(200)
    const access = await request(`/v1/project-shares/${projectId}`, 'GET', invited.session.accessToken)
    expect((await access.json<any>()).projectShare).toMatchObject({ role: 'member', permissionRevision: 2 })
    const grantResponse = await post(`/v1/project-shares/${projectId}/device-grant`, {}, invited.session.accessToken)
    expect(grantResponse.status).toBe(201)
    const grant = (await grantResponse.json<any>()).grant
    expect(grant).toMatchObject({ status: 'pending', keyEpoch: 1 })
    const pending = await request(`/v1/project-shares/${projectId}/device-grants`, 'GET', owner.session.accessToken)
    expect((await pending.json<any>()).grants).toMatchObject([{ id: grant.id, deviceId: expect.any(String) }])
    expect((await request(`/v1/project-shares/${projectId}/device-grants`, 'GET', invited.session.accessToken)).status).toBe(404)
    expect((await post(`/v1/project-shares/${projectId}/device-grants/${grant.id}/complete`, {
      wrappedProjectKey: 'wrapped-project-key-material-long', keyEpoch: 2
    }, owner.session.accessToken)).status).toBe(409)
    expect((await post(`/v1/project-shares/${projectId}/device-grants/${grant.id}/complete`, {
      wrappedProjectKey: 'wrapped-project-key-material-long', keyEpoch: 1
    }, invited.session.accessToken)).status).toBe(404)
    expect((await post(`/v1/project-shares/${projectId}/device-grants/${grant.id}/complete`, {
      wrappedProjectKey: 'wrapped-project-key-material-long', keyEpoch: 1
    }, owner.session.accessToken)).status).toBe(204)
    const activeGrant = await request(`/v1/project-shares/${projectId}/device-grant`, 'GET', invited.session.accessToken)
    expect((await activeGrant.json<any>()).grant).toMatchObject({
      id: grant.id, status: 'active', wrappedProjectKey: 'wrapped-project-key-material-long'
    })
    const retriedGrant = await post(`/v1/project-shares/${projectId}/device-grant`, {}, invited.session.accessToken)
    expect((await retriedGrant.json<any>()).grant).toMatchObject({
      id: grant.id, status: 'active', wrappedProjectKey: 'wrapped-project-key-material-long'
    })
    expect((await request(`/v1/project-shares/${projectId}/device-grant`, 'GET', stranger.session.accessToken)).status).toBe(404)
    expect((await post(`/v1/project-shares/${projectId}/invitations`, {
      email: 'third@example.com'
    }, invited.session.accessToken)).status).toBe(404)
    expect((await request(`/v1/project-shares/${projectId}/members/${owner.user.id}`, 'DELETE', invited.session.accessToken)).status).toBe(404)
    expect((await request(`/v1/project-shares/${projectId}/members/${invited.user.id}`, 'DELETE', owner.session.accessToken)).status).toBe(204)
    expect((await request(`/v1/project-shares/${projectId}`, 'GET', invited.session.accessToken)).status).toBe(404)
    expect((await request(`/v1/project-shares/${projectId}/device-grant`, 'GET', invited.session.accessToken)).status).toBe(404)
    const ownerView = await request(`/v1/project-shares/${projectId}`, 'GET', owner.session.accessToken)
    expect((await ownerView.json<any>()).projectShare).toMatchObject({ permissionRevision: 3, keyEpoch: 2 })
    expect((await post('/v1/project-invitations/accept', {
      token: invitation.token
    }, invited.session.accessToken)).status).toBe(404)
  })

  it('keeps revoked and closed invitations unusable', async () => {
    const owner = await signIn('revoke-owner@example.com')
    const invited = await signIn('revoke-member@example.com')
    const localProjectId = crypto.randomUUID()
    const projectId = await registerShare(localProjectId, owner.device.hostId, owner.session.accessToken)
    const first = (await (await post(`/v1/project-shares/${projectId}/invitations`, {
      email: 'revoke-member@example.com'
    }, owner.session.accessToken)).json<any>()).invitation
    expect((await request(`/v1/project-shares/${projectId}/invitations/${first.id}`, 'DELETE', owner.session.accessToken)).status).toBe(204)
    expect((await post('/v1/project-invitations/accept', { token: first.token }, invited.session.accessToken)).status).toBe(404)
    const second = (await (await post(`/v1/project-shares/${projectId}/invitations`, {
      email: 'revoke-member@example.com'
    }, owner.session.accessToken)).json<any>()).invitation
    expect((await request(`/v1/project-shares/${projectId}`, 'DELETE', owner.session.accessToken)).status).toBe(204)
    expect((await post('/v1/project-invitations/accept', { token: second.token }, invited.session.accessToken)).status).toBe(404)
    expect((await request(`/v1/project-shares/${projectId}`, 'GET', owner.session.accessToken)).status).toBe(404)
    const reopened = await post('/v1/project-shares', {
      localProjectId, executionHostId: owner.device.hostId
    }, owner.session.accessToken)
    expect(reopened.status).toBe(200)
    expect((await reopened.json<any>()).projectShare).toMatchObject({ keyEpoch: 3, permissionRevision: 3 })
    expect((await post('/v1/project-invitations/accept', { token: second.token }, invited.session.accessToken)).status).toBe(404)
  })

  it('turns surviving device grants into pending grants after member removal', async () => {
    const owner = await signIn('rotate-owner@example.com')
    const removed = await signIn('rotate-removed@example.com')
    const surviving = await signIn('rotate-surviving@example.com')
    const projectId = await registerShare(crypto.randomUUID(), owner.device.hostId, owner.session.accessToken)
    for (const [email, member] of [
      ['rotate-removed@example.com', removed], ['rotate-surviving@example.com', surviving]
    ] as const) {
      const invitation = (await (await post(`/v1/project-shares/${projectId}/invitations`, {
        email
      }, owner.session.accessToken)).json<any>()).invitation
      await post('/v1/project-invitations/accept', { token: invitation.token }, member.session.accessToken)
      const grant = (await (await post(`/v1/project-shares/${projectId}/device-grant`, {},
        member.session.accessToken)).json<any>()).grant
      await post(`/v1/project-shares/${projectId}/device-grants/${grant.id}/complete`, {
        wrappedProjectKey: 'wrapped-project-key-material-long', keyEpoch: 1
      }, owner.session.accessToken)
    }
    expect((await request(`/v1/project-shares/${projectId}/members/${removed.user.id}`,
      'DELETE', owner.session.accessToken)).status).toBe(204)
    expect((await request(`/v1/project-shares/${projectId}/device-grant`,
      'GET', removed.session.accessToken)).status).toBe(404)
    const survivorGrant = await request(`/v1/project-shares/${projectId}/device-grant`,
      'GET', surviving.session.accessToken)
    expect((await survivorGrant.json<any>()).grant).toMatchObject({
      status: 'pending', keyEpoch: 2, wrappedProjectKey: null
    })
    const pending = await request(`/v1/project-shares/${projectId}/device-grants`,
      'GET', owner.session.accessToken)
    expect((await pending.json<any>()).grants).toMatchObject([
      { userId: surviving.user.id, keyEpoch: 2 }
    ])
  })
})
