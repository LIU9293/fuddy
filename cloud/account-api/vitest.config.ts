import { readFileSync } from 'node:fs'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          ENVIRONMENT: 'test',
          EMAIL_DELIVERY_MODE: 'test',
          OTP_PEPPER: 'test-otp-pepper',
          SESSION_TOKEN_PEPPER: 'test-session-pepper',
          RESEND_FROM: 'Fuddy <onboarding@resend.dev>',
          RESEND_API_KEY: '',
          RESEND_WEBHOOK_SECRET: 'whsec_MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=',
          GOOGLE_CLIENT_IDS: ''
        },
        d1Databases: ['ACCOUNT_DB'],
        d1Persist: false,
        bindingsPersist: false
      }
    })
  ],
  test: {
    setupFiles: ['./test/setup.ts'],
    server: {
      deps: {
        inline: ['jose', 'svix']
      }
    }
  },
  define: {
    __ACCOUNT_MIGRATION_SQL__: JSON.stringify([
      readFileSync('./migrations/0001_initial.sql', 'utf8'),
      readFileSync('./migrations/0002_relay_binding.sql', 'utf8'),
      readFileSync('./migrations/0003_device_installation_identity.sql', 'utf8'),
      readFileSync('./migrations/0004_relay_revocations.sql', 'utf8'),
      readFileSync('./migrations/0005_email_delivery.sql', 'utf8'),
      readFileSync('./migrations/0006_refresh_history.sql', 'utf8'),
      readFileSync('./migrations/0007_host_space_uniqueness.sql', 'utf8'),
      readFileSync('./migrations/0008_relay_revocation_jobs.sql', 'utf8')
    ].join('\n'))
  }
})
