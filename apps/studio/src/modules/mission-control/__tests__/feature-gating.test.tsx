// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MissionControlLayout } from '../layout';

/**
 * Mission Control hides entry points of features the server runs without
 * (P02 task 5.1): Intents and "Compose intent" need content goals, Agents
 * needs the multi-agent newsroom.
 */

const features = vi.hoisted(() => ({ current: { agentNewsroom: false, contentGoals: false } }));

vi.mock('@/lib/features', () => ({
  useServerFeatures: () => ({
    graphql: false,
    externalIssuers: false,
    loginAnomaly: false,
    metrics: false,
    fieldEncryption: false,
    ...features.current,
  }),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={String(to)} {...rest}>
      {children}
    </a>
  ),
  useRouterState: () => ({ location: { pathname: '/mission-control', search: {} } }),
  useNavigate: () => vi.fn(),
}));

vi.mock('../intent-composer', () => ({ IntentComposer: () => null }));
vi.mock('../kill-switch', () => ({ KillSwitchPanel: () => null }));

describe('Mission Control feature gating', () => {
  beforeEach(() => {
    features.current = { agentNewsroom: false, contentGoals: false };
  });
  afterEach(() => cleanup());

  it('hides Intents, Agents and Compose intent while the features are off', () => {
    render(<MissionControlLayout>body</MissionControlLayout>);
    expect(screen.queryByRole('link', { name: 'Intents' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Agents' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Compose intent/ })).toBeNull();
    expect(screen.getByRole('link', { name: 'Goals' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Kill switch/ })).toBeTruthy();
  });

  it('shows them once the server reports the features on', () => {
    features.current = { agentNewsroom: true, contentGoals: true };
    render(<MissionControlLayout>body</MissionControlLayout>);
    expect(screen.getByRole('link', { name: 'Intents' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Agents' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Compose intent/ })).toBeTruthy();
  });
});
