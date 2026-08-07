import { describe, expect, it } from 'vitest'
import { parsePostgresConnectionString } from './connector-runtime'

describe('PostgreSQL connection configuration', () => {
  it('extracts safe configuration separately from the password', () => {
    const parsed = parsePostgresConnectionString(
      'postgresql://project_user:p%40ssword@db.example.com:6432/project_db?sslmode=require'
    )

    expect(parsed.password).toBe('p@ssword')
    expect(parsed.config).toEqual({
      host: 'db.example.com',
      port: 6432,
      database: 'project_db',
      user: 'project_user',
      sslMode: 'require'
    })
    expect(JSON.stringify(parsed.config)).not.toContain('p@ssword')
  })

  it('defaults local connections to no TLS and remote connections to TLS', () => {
    expect(parsePostgresConnectionString('postgres://dev@localhost/app').config.sslMode).toBe('disable')
    expect(parsePostgresConnectionString('postgres://reader@db.example.com/app').config.sslMode).toBe('require')
  })

  it('rejects non-PostgreSQL URLs and incomplete targets', () => {
    expect(() => parsePostgresConnectionString('https://example.com/db')).toThrow('postgres://')
    expect(() => parsePostgresConnectionString('postgres://example.com/db')).toThrow('user')
  })
})
