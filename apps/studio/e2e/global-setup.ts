import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { FullConfig } from '@playwright/test';
import { ADMIN, SEED_FILE } from './fixtures';

const cmsDir = path.resolve(import.meta.dirname, '../../cms');

function seedScript(...args: string[]): void {
  execFileSync('npx', ['tsx', 'scripts/e2e-studio-seed.ts', ...args], { cwd: cmsDir, stdio: 'inherit', env: process.env });
}

/** Reset the disposable database, run first-time setup on the built server, then seed. */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]!.use.baseURL!;
  seedScript('reset');
  const res = await fetch(`${baseURL}/api/v1/setup/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      account: { email: ADMIN.email, password: ADMIN.password, firstName: 'E2E', lastName: 'Admin' },
      adminPath: ADMIN.path,
      // The standard lockout policy (apps/cms/src/modules/setup/policy-codec.ts).
      policy: {
        userMaxFailedAttempts: 5,
        userLockoutDurationSeconds: 900,
        ipMaxFailedAttempts: 20,
        ipLockoutDurationSeconds: 3600,
        lockoutWindowSeconds: 900,
        geoAnomalyEnabled: true,
        timeAnomalyEnabled: false,
        deviceAnomalyEnabled: true,
        anomalyScoreThreshold: 0.7,
        anomalyAction: 'notify_only',
        notifyChannels: ['email'],
        loginStallMs: 0,
      },
      project: { defaultLanguage: 'en', siteUrl: 'https://studio-e2e.example.test', displayTitle: 'Studio E2E' },
    }),
  });
  if (res.status !== 201) throw new Error(`setup failed: ${res.status} ${await res.text()}`);
  mkdirSync(path.dirname(SEED_FILE), { recursive: true });
  seedScript('seed', SEED_FILE);
}
