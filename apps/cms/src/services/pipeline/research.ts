import type { ChatCallInput, ChatCallResult } from '../llm/gateway';
import { DATA_NOT_INSTRUCTIONS, asData, parseModelJson } from './safety';

/**
 * The bounded research agent of the `write` mode (HeoPress P09 task 1.5; spec ai/content-pipeline "改写与撰写带引用";
 * design decision 1, ADR-0007).
 *
 * A loop the runtime controls, not the model: each turn the model may ask for **one** tool from the whitelist
 * (`read_source`: one of the production's own source documents; `site_search`: published items of this site), or
 * finish. A tool outside the whitelist is refused and recorded, never run. The run ends — terminated, with the reason
 * recorded and no draft — when it reaches the step cap, the time cap or the money cap. Tool results are data, like the
 * sources.
 */

const RESEARCH_TOOLS = ['read_source', 'site_search'] as const;
type ResearchTool = (typeof RESEARCH_TOOLS)[number];

export interface ResearchLimits {
  maxSteps: number;
  maxMs: number;
  maxCostMicros: number;
}

export const DEFAULT_RESEARCH_LIMITS: ResearchLimits = { maxSteps: 6, maxMs: 120_000, maxCostMicros: 2_000_000 };

export class ResearchTerminatedError extends Error {
  constructor(
    readonly reason: 'max_steps' | 'max_time' | 'max_cost',
    readonly steps: ResearchStep[],
  ) {
    super(`RESEARCH_TERMINATED: ${reason}`);
    this.name = 'ResearchTerminatedError';
  }
}

export interface ResearchStep {
  n: number;
  tool: string | null;
  outcome: 'ran' | 'refused' | 'finished' | 'invalid';
  callId: string;
}

export interface ResearchDeps {
  chat(input: ChatCallInput): Promise<ChatCallResult>;
  tools: Record<ResearchTool, (args: Record<string, unknown>) => Promise<unknown>>;
  /** Money spent on a call (ledger), for the cost cap. */
  costOf(callId: string): Promise<number>;
  /** Called after each model call (the run record). */
  onCall(result: ChatCallResult, step: ResearchStep): Promise<void>;
  now?: () => number;
}

const SYSTEM = `You research a topic for an article using only the tools listed in the data (tools).
${DATA_NOT_INSTRUCTIONS}
Each turn answer with JSON only: {"action":"tool","tool":"<one of tools>","args":{...}} or {"action":"finish","notes":"<what you found, with the source ids that support it>"}.`;

export async function runResearch(
  deps: ResearchDeps,
  input: { siteId: string; productionId: string; brief: unknown; limits: ResearchLimits; editorialProfileVersion: number | null; promptVersion: string },
): Promise<{ notes: string; steps: ResearchStep[] }> {
  const now = deps.now ?? Date.now;
  const started = now();
  const steps: ResearchStep[] = [];
  const transcript: Array<{ tool: string; args: unknown; result: unknown }> = [];
  let spent = 0;
  for (let n = 1; ; n++) {
    if (n > input.limits.maxSteps) throw new ResearchTerminatedError('max_steps', steps);
    if (now() - started > input.limits.maxMs) throw new ResearchTerminatedError('max_time', steps);
    if (spent >= input.limits.maxCostMicros) throw new ResearchTerminatedError('max_cost', steps);
    const out = await deps.chat({
      siteId: input.siteId,
      taskType: 'generation',
      capability: 'write',
      origin: { kind: 'ai_production', id: input.productionId },
      callKey: `production:${input.productionId}:research:${n}`,
      systemPrompt: SYSTEM,
      tools: false,
      messages: [{ role: 'user', content: asData({ tools: RESEARCH_TOOLS, brief: input.brief, transcript, stepsLeft: input.limits.maxSteps - n }) }],
      maxOutputTokens: 800,
      deadlineMs: Math.max(1000, input.limits.maxMs - (now() - started)),
    });
    spent += await deps.costOf(out.callId);
    const answer = parseModelJson(out.response.content);
    const step: ResearchStep = { n, tool: null, outcome: 'invalid', callId: out.callId };
    steps.push(step);
    if (answer?.action === 'finish') {
      step.outcome = 'finished';
      await deps.onCall(out, step);
      return { notes: typeof answer.notes === 'string' ? answer.notes.slice(0, 20_000) : '', steps };
    }
    if (answer?.action === 'tool' && typeof answer.tool === 'string') {
      step.tool = answer.tool;
      const args = answer.args && typeof answer.args === 'object' ? (answer.args as Record<string, unknown>) : {};
      if ((RESEARCH_TOOLS as readonly string[]).includes(answer.tool)) {
        step.outcome = 'ran';
        transcript.push({ tool: answer.tool, args, result: await deps.tools[answer.tool as ResearchTool](args) });
      } else {
        // Not on the whitelist: refused, never run.
        step.outcome = 'refused';
        transcript.push({ tool: answer.tool, args, result: { error: 'tool_not_allowed' } });
      }
    }
    await deps.onCall(out, step);
  }
}
