// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';
import { missionControlApi, type AutonomyGrant, type PromotionCheckResult } from './api';

/**
 * Trust ledger UI (content-os task 17.2; Req 16.3): role × capability
 * matrix with earned levels, plus pending promotion proposals a human can
 * decide — promotion is never automatic.
 */

/**
 * Promotion eligibility check (content-os-ui task 20; Req 20): lets a human
 * proactively ask "has this (role, capability) earned a raise?" instead of
 * waiting for the periodic promote-check. A `proposed=true` answer creates
 * a real proposal (still human-gated); `false` shows the evidence verdict.
 */
function PromotionCheck({ grants }: { grants: AutonomyGrant[] }) {
  const { t } = useTranslation('agents');
  const queryClient = useQueryClient();
  const [agentRole, setAgentRole] = useState('');
  const [capability, setCapability] = useState('');
  const [result, setResult] = useState<PromotionCheckResult | null>(null);

  const checkMutation = useMutation({
    mutationFn: () => missionControlApi.checkPromotion(agentRole.trim(), capability.trim()),
    onSuccess: (data) => {
      setResult(data);
      if (data.proposed) {
        void queryClient.invalidateQueries({ queryKey: ['mc-promotions'] });
      }
    },
  });

  const roleSuggestions = [...new Set(grants.map((g) => g.agentRole))];
  const capabilitySuggestions = [...new Set(grants.map((g) => g.capability))];

  return (
    <section>
      <h3 className="mb-2 t-section">{t('trust.checkTitle')}</h3>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs">
          <span className="mb-1 block text-dim">{t('trust.role')}</span>
          <input
            value={agentRole}
            onChange={(e) => setAgentRole(e.target.value)}
            list="trust-role-suggestions"
            placeholder={t('trust.rolePlaceholder')}
            className="rounded-ctl border border-line bg-bg px-2 py-1.5 font-mono"
          />
          <datalist id="trust-role-suggestions">
            {roleSuggestions.map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
        </label>
        <label className="text-xs">
          <span className="mb-1 block text-dim">{t('trust.capability')}</span>
          <input
            value={capability}
            onChange={(e) => setCapability(e.target.value)}
            list="trust-capability-suggestions"
            placeholder={t('trust.capabilityPlaceholder')}
            className="rounded-ctl border border-line bg-bg px-2 py-1.5 font-mono"
          />
          <datalist id="trust-capability-suggestions">
            {capabilitySuggestions.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </label>
        <button
          type="button"
          onClick={() => checkMutation.mutate()}
          disabled={checkMutation.isPending || !agentRole.trim() || !capability.trim()}
          className="rounded-ctl border border-line px-3 py-1.5 text-xs font-medium hover:bg-panel-2 disabled:opacity-50"
        >
          {checkMutation.isPending ? t('trust.checking') : t('trust.check')}
        </button>
      </div>
      {checkMutation.isError && (
        <p className="mt-2 text-xs text-bad">
          {checkMutation.error instanceof Error ? checkMutation.error.message : t('trust.checkFailed')}
        </p>
      )}
      {result && (
        <div
          className={cn(
            'mt-2 rounded-ctl border border-line p-2 text-xs',
            result.proposed
              ? 'border-ok/40 bg-ok-soft text-ok'
              : 'bg-panel-2 text-dim',
          )}
        >
          {result.proposed ? (
            <p className="font-medium">
              {t('trust.eligible')}
            </p>
          ) : (
            <>
              <p className="font-medium text-fg">{t('trust.notEligible')}</p>
              <p className="mt-1 font-mono">{JSON.stringify(result)}</p>
            </>
          )}
        </div>
      )}
    </section>
  );
}

export function TrustLedger() {
  const { t } = useTranslation('agents');
  const queryClient = useQueryClient();
  const autonomyQuery = useQuery({ queryKey: ['mc-autonomy'], queryFn: missionControlApi.autonomy });
  const promotionsQuery = useQuery({ queryKey: ['mc-promotions'], queryFn: missionControlApi.promotions });

  const decideMutation = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'approved' | 'rejected' }) =>
      missionControlApi.decidePromotion(id, decision),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['mc-autonomy'] });
      void queryClient.invalidateQueries({ queryKey: ['mc-promotions'] });
    },
  });

  if (autonomyQuery.isLoading) {
    return <p className="text-sm text-dim">{t('trust.loading')}</p>;
  }
  const grants = autonomyQuery.data?.grants ?? [];
  const proposals = promotionsQuery.data ?? [];

  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-2 t-section">{t('trust.earnedTitle')}</h3>
        {grants.length === 0 ? (
          <p className="text-sm text-dim">
            {t('trust.noGrants')}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase text-dim">
                <th className="py-2">{t('trust.role')}</th>
                <th>{t('trust.capability')}</th>
                <th>{t('trust.level')}</th>
                <th>{t('trust.granted')}</th>
              </tr>
            </thead>
            <tbody>
              {grants.map((grant) => (
                <tr key={grant.id} className="border-b border-line last:border-0">
                  <td className="py-2 font-medium">{grant.agentRole}</td>
                  <td>
                    <code className="rounded bg-panel-2 px-1 text-xs">{grant.capability}</code>
                  </td>
                  <td>
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-xs',
                        grant.level >= 3 ? 'bg-ok-soft text-ok' : 'bg-panel-2',
                      )}
                    >
                      {t(`levels.${grant.level}`, { defaultValue: `L${grant.level}` })}
                    </span>
                  </td>
                  <td className="text-xs text-dim">
                    {new Date(grant.grantedAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <PromotionCheck grants={grants} />

      <section>
        <h3 className="mb-2 t-section">{t('trust.pendingTitle')}</h3>
        {proposals.length === 0 ? (
          <p className="text-sm text-dim">{t('trust.noProposals')}</p>
        ) : (
          <ul className="space-y-2">
            {proposals.map((proposal) => (
              <li
                key={proposal.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-line p-3 text-sm"
              >
                <span>
                  {t('trust.proposal')} <code className="rounded bg-panel-2 px-1 text-xs">{proposal.id}</code>
                  <span className="ml-2 text-xs text-dim">
                    {new Date(proposal.createdAt).toLocaleString()}
                  </span>
                </span>
                <span className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => decideMutation.mutate({ id: proposal.id, decision: 'approved' })}
                    disabled={decideMutation.isPending}
                    className="rounded-ctl border border-ok/40 px-2 py-1 text-xs text-ok hover:bg-ok-soft"
                  >
                    {t('trust.approveRaise')}
                  </button>
                  <button
                    type="button"
                    onClick={() => decideMutation.mutate({ id: proposal.id, decision: 'rejected' })}
                    disabled={decideMutation.isPending}
                    className="rounded-ctl border border-bad/40 px-2 py-1 text-xs text-bad hover:bg-bad-soft"
                  >
                    {t('inbox.reject')}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
