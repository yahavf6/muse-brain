import { callVerb, getDb } from '../src/verbs.ts';
import type { Who } from '../src/verbs.ts';

const claudeCode: Who = { agent: 'claude-code', scope: 'full' };
const codex: Who = { agent: 'codex', scope: 'full' };
const yahav: Who = { agent: 'yahav', scope: 'full' };

async function log(who: Who, args: Record<string, unknown>): Promise<number> {
  const r = (await callVerb('log', args, who)) as { id: number };
  return r.id;
}
async function approveIfNeeded(id: number, approvedBy: string): Promise<void> {
  const g = (await callVerb('get', { ids: [id] }, yahav)) as { nodes: { status: string | null }[] };
  if (g.nodes[0]?.status === 'proposed') await callVerb('approve_rule', { id, approved_by: approvedBy }, yahav);
}

// --- onboarding story ---
const t1 = await log(claudeCode, { kind: 'thought', title: 'Users drop at the longest onboarding step', why: '', project: 'reddgrow' });
const a1 = await log(claudeCode, {
  kind: 'action', title: 'Removed the subreddit picker from onboarding, auto-assign instead',
  why: 'The picker made users research subreddits before they saw any value; cutting it removes the longest step.',
  project: 'reddgrow', links: [{ type: 'motivated_by', to: t1 }],
  files: ['apps/web/components/onboarding/AssignSubredditsStep.tsx'],
});
const c1 = await log(claudeCode, {
  kind: 'conclusion', title: 'Activation rose after the picker was removed', verdict: 'good',
  why: 'Post-launch activation rate increased over the two weeks after the change.',
  project: 'reddgrow', links: [{ type: 'evaluates', to: a1 }, { type: 'supports', to: t1 }],
});
const r1 = await log(claudeCode, {
  kind: 'rule', title: 'Onboarding must not ask the user to do research',
  why: 'Removing the research step (the subreddit picker) raised activation; new onboarding steps should not reintroduce one.',
  links: [{ type: 'derived_from', to: c1 }],
});
await approveIfNeeded(r1, 'Yahav');

// --- approved company-wide rules ---
const emDash = await log(yahav, {
  kind: 'rule', title: 'Never use em-dashes in copy or email',
  why: 'Em-dashes read as AI-generated; reddgrow copy is em-dash-free by house style.',
  guard: { tool: '(send|reply|publish|draft)', deny_if: '—' },
});
await approveIfNeeded(emDash, 'Yahav');

const refund = await log(yahav, {
  kind: 'rule', title: 'Refund within 14 days, no questions asked',
  why: 'Keeps support load low and trust high; matches the stated policy.',
});
await approveIfNeeded(refund, 'Yahav');

// --- brand font: approved rule superseded by a newly-approved one (supersede_on_approve) ---
const interRule = await log(yahav, { kind: 'rule', title: 'Brand font is Inter', why: 'Original brand typography choice.' });
await approveIfNeeded(interRule, 'Yahav');
const fontsRule = await log(yahav, {
  kind: 'rule', title: 'Brand fonts are Fraunces and Plus Jakarta Sans',
  why: 'Refreshed brand type pairing replaces the single Inter font.',
  links: [{ type: 'supersedes', to: interRule }],
});
await approveIfNeeded(fontsRule, 'Yahav');

// --- codex cold-email thread: a thought that gets refuted ---
const t2 = await log(codex, { kind: 'thought', title: 'Short subject lines get more cold email replies', why: '', project: 'reddgrow' });
const a2 = await log(codex, {
  kind: 'action', title: 'Sent a short-subject cold email variant to a test segment',
  why: 'Testing the short-subject-line hypothesis against the control.',
  project: 'reddgrow', links: [{ type: 'motivated_by', to: t2 }],
});
const c2 = await log(codex, {
  kind: 'conclusion', title: 'Reply rate did not improve with short subjects', verdict: 'bad',
  why: 'A/B test showed no lift over the control after two weeks.',
  project: 'reddgrow', links: [{ type: 'evaluates', to: a2 }, { type: 'refutes', to: t2 }],
});
await log(codex, {
  kind: 'rule', title: "Cold email subjects must name the prospect's company",
  why: 'Personalized subjects tested better than short generic ones in the same experiment.',
  links: [{ type: 'derived_from', to: c2 }],
});
// left proposed on purpose

// --- refund compliance ---
await log(claudeCode, {
  kind: 'action', title: 'Refunded a customer on day 9',
  why: 'Within the 14-day refund window.',
  project: 'reddgrow', links: [{ type: 'complies_with', to: refund }],
  files: ['apps/web/app/pricing/page.tsx'],
});

// --- stale action: >14 days old, no conclusion, so the outcome gate has something to say ---
const staleId = await log(claudeCode, {
  kind: 'action', title: 'Migrated the email queue to the new provider',
  why: "The old provider's deliverability had degraded.",
  project: 'reddgrow',
});
getDb().prepare("UPDATE node SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-20 days') WHERE id = ?").run(staleId);

console.log('seed complete');
