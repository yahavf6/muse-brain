import { callVerb, getDb } from '../src/verbs.ts';
import type { Who } from '../src/verbs.ts';
import { DEFAULT_DB } from '../src/db.ts';

const DB_PATH = process.env.BRAIN_DB ?? DEFAULT_DB;
console.log(`Seeding ${DB_PATH}`);

const existingCount = (getDb().prepare('SELECT COUNT(*) AS c FROM node').get() as { c: number }).c;
if (existingCount > 0 && !process.argv.includes('--force')) {
  console.error(`Refusing to seed: ${DB_PATH} already has ${existingCount} node(s). Pass --force to seed anyway.`);
  process.exit(1);
}

const claudeCode: Who = { agent: 'claude-code', scope: 'full' };
const codex: Who = { agent: 'codex', scope: 'full' };
const human: Who = { agent: 'jordan', scope: 'full' };

// Fictional demo company: Lumen, a small B2B SaaS team. Every seeded node is scoped
// project: 'demo', rules included, so it never binds real work: scoped queries
// (project IS NULL OR project = <repo>) can't inject a demo rule or guard into a real
// repo. This is the one place that guarantee is enforced -- callers below never set project.
async function log(who: Who, args: Record<string, unknown>): Promise<number> {
  const r = (await callVerb('log', { ...args, project: 'demo' }, who)) as { id: number };
  return r.id;
}
async function approveIfNeeded(id: number, approvedBy: string): Promise<void> {
  const g = (await callVerb('get', { ids: [id] }, human)) as { nodes: { status: string | null }[] };
  if (g.nodes[0]?.status === 'proposed') await callVerb('approve_rule', { id, approved_by: approvedBy }, human);
}
function backdate(id: number, days: number): void {
  getDb().prepare("UPDATE node SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now', ?) WHERE id = ?").run(`-${days} days`, id);
}

// --- company-wide standalone rules ---
const refund = await log(human, {
  kind: 'rule', title: 'Refund within 14 days, no questions asked',
  why: 'Keeps support load low and trust high; matches the stated policy.',
});
await approveIfNeeded(refund, 'jordan');

const shipDateGuard = await log(human, {
  kind: 'rule', title: 'Outbound emails must not promise a specific ship date',
  why: 'A promised date turns into a support ticket the moment it slips; keep launch language vague until GA.',
  guard: { tool: '(send|reply|draft)', deny_if: '\\b(ship|launch)(ing)?\\s+(by|on)\\b' },
});
await approveIfNeeded(shipDateGuard, 'jordan');

// --- brand color rule superseded by a newly-approved one ---
const brandOld = await log(human, { kind: 'rule', title: 'Primary brand color is Lumen Blue', why: 'Original brand color choice at launch.' });
await approveIfNeeded(brandOld, 'jordan');
const brandNew = await log(human, {
  kind: 'rule', title: 'Primary brand colors are Lumen Indigo and Lumen Amber',
  why: 'Refreshed palette replaces the single launch blue; amber carries CTAs.',
  links: [{ type: 'supersedes', to: brandOld }],
});
await approveIfNeeded(brandNew, 'jordan');

// --- support SLA rule superseded by a newly-approved one ---
const slaOld = await log(human, { kind: 'rule', title: 'Support inbox must be checked every 4 hours', why: 'Original SLA when the team was two people.' });
await approveIfNeeded(slaOld, 'jordan');
const slaNew = await log(human, {
  kind: 'rule', title: 'Support inbox must be checked within 1 hour during business hours',
  why: 'Team grew past two people; the 4-hour SLA was losing trial users to slow first response.',
  links: [{ type: 'supersedes', to: slaOld }],
});
await approveIfNeeded(slaNew, 'jordan');

// --- pricing page: annual-default toggle ---
const t1 = await log(claudeCode, { kind: 'thought', title: 'Defaulting the pricing toggle to monthly suppresses upgrade clicks', why: '', confidence: 0.65 });
const a1 = await log(claudeCode, {
  kind: 'action', title: 'Set the pricing page billing toggle to default to annual',
  why: 'Most visitors never touch the toggle, so the default they land on is effectively the plan they compare; monthly undersells the discount.',
  alternatives: ['leave default as monthly and rely on toggle copy', 'show annual price with a strikethrough monthly price instead of a toggle'],
  evidence: ['pricing page toggle click heatmap, 2 weeks'],
  files: ['apps/web/pricing/PricingToggle.tsx', 'apps/web/pricing/page.tsx'],
  links: [{ type: 'motivated_by', to: t1 }],
});
const c1 = await log(claudeCode, {
  kind: 'conclusion', title: 'Annual-default toggle raised plan value at checkout', verdict: 'good',
  why: 'Average selected plan value per new checkout increased over the two weeks after the change.',
  links: [{ type: 'evaluates', to: a1 }, { type: 'supports', to: t1 }],
});
const r1 = await log(claudeCode, {
  kind: 'rule', title: 'Pricing pages must default the billing toggle to annual',
  why: 'The annual-default change raised checkout value; new pricing surfaces should not default to monthly.',
  links: [{ type: 'derived_from', to: c1 }],
});
await approveIfNeeded(r1, 'jordan');
await log(claudeCode, {
  kind: 'rule', title: 'Pricing experiments must run at least 2 full weeks before a verdict',
  why: "The annual-default read looked good within days, but weekend traffic skews it; a longer window avoids a false-good call.",
  links: [{ type: 'derived_from', to: c1 }],
});
// left proposed on purpose
await log(claudeCode, {
  kind: 'action', title: 'Applied the annual-default toggle to the homepage pricing teaser',
  why: "Same reasoning as the pricing page: the teaser's default should match the plan value it's meant to sell.",
  files: ['apps/web/home/PricingTeaser.tsx'],
  links: [{ type: 'follows', to: a1 }, { type: 'complies_with', to: r1 }],
});
await log(claudeCode, {
  kind: 'thought', title: 'The annual-default pattern might help the homepage pricing teaser too', why: '', confidence: 0.35,
  links: [{ type: 'derived_from', to: c1 }],
});

// --- email queue migration: stale action, no conclusion yet ---
const t2 = await log(codex, { kind: 'thought', title: "The email provider's declining deliverability is costing signups", why: '', confidence: 0.55 });
const a2 = await log(codex, {
  kind: 'action', title: 'Migrated the transactional email queue to a new provider',
  why: "The previous provider's deliverability had degraded over the prior month, and signup/verification emails were landing in spam.",
  alternatives: ['negotiate a dedicated IP with the old provider', 'add a second provider as failover instead of migrating'],
  evidence: ['deliverability dashboard, 30-day trend'],
  files: ['apps/api/email/queue.ts', 'apps/api/email/provider.ts'],
  links: [{ type: 'motivated_by', to: t2 }],
});
backdate(a2, 20);

// --- onboarding: single-screen wizard ---
const t3 = await log(claudeCode, { kind: 'thought', title: 'The 5-step signup wizard causes drop-off before activation', why: '', confidence: 0.7 });
const a3 = await log(claudeCode, {
  kind: 'action', title: 'Collapsed the 5-step onboarding wizard into a single screen',
  why: 'Funnel data showed most drop-off happened between steps 2 and 4, not at the fields themselves; fewer screens should keep more people moving.',
  alternatives: ['keep 5 steps but add a progress bar', 'let users skip steps and fill them in later'],
  evidence: ['onboarding funnel report, 4 weeks'],
  files: ['apps/web/onboarding/SignupWizard.tsx', 'apps/web/onboarding/steps/index.ts'],
  links: [{ type: 'motivated_by', to: t3 }],
});
const c3 = await log(claudeCode, {
  kind: 'conclusion', title: 'Single-screen onboarding lifted step completion', verdict: 'good',
  why: 'Step completion rate rose and time-to-first-value dropped after the collapse shipped.',
  links: [{ type: 'evaluates', to: a3 }, { type: 'supports', to: t3 }],
});
const r3 = await log(claudeCode, {
  kind: 'rule', title: 'Onboarding must fit on a single screen',
  why: 'Collapsing the wizard raised completion; new onboarding steps should not reintroduce a multi-step flow.',
  links: [{ type: 'derived_from', to: c3 }],
});
await approveIfNeeded(r3, 'jordan');
await log(claudeCode, {
  kind: 'action', title: 'Added optional profile fields to the single-screen onboarding',
  why: 'Sales wanted company size captured at signup; kept it on the same screen to stay inside the one-screen rule.',
  files: ['apps/web/onboarding/SignupWizard.tsx'],
  links: [{ type: 'follows', to: a3 }, { type: 'complies_with', to: r3 }],
});
await log(claudeCode, {
  kind: 'thought', title: 'The single-screen pattern might reduce drop-off in the team-invite flow too', why: '', confidence: 0.4,
  links: [{ type: 'derived_from', to: c3 }],
});

// --- API rate limit tiers: stale action, no conclusion yet ---
const t4 = await log(codex, { kind: 'thought', title: 'A shared per-IP rate limit blocks legitimate bulk API customers', why: '', confidence: 0.6 });
const a4 = await log(codex, {
  kind: 'action', title: 'Introduced per-API-key rate limit tiers',
  why: 'Several paying customers share an office IP or a proxy and were hitting the same per-IP ceiling as free-tier abuse traffic.',
  alternatives: ['raise the shared per-IP limit for everyone', 'let customers request a manual allowlist exception'],
  evidence: ["support tickets tagged 'rate limit', 6 weeks"],
  files: ['apps/api/middleware/rateLimit.ts', 'apps/api/billing/planLimits.ts'],
  links: [{ type: 'motivated_by', to: t4 }],
});
backdate(a4, 21);

// --- API rate limit: refuted thought ---
const t5 = await log(codex, { kind: 'thought', title: 'Raising the default rate limit will stop throttling support tickets', why: '', confidence: 0.8 });
const a5 = await log(codex, {
  kind: 'action', title: 'Raised the default API rate limit to 1000 requests per minute for all plans',
  why: 'Throttling was the most common support tag; raising the ceiling looked like the fastest fix.',
  alternatives: ['only raise the limit for paid plans', 'add a burst allowance instead of raising the steady-state limit'],
  evidence: ["support tickets tagged 'rate limit', 6 weeks"],
  files: ['apps/api/middleware/rateLimit.ts'],
  links: [{ type: 'motivated_by', to: t5 }],
});
const c5 = await log(codex, {
  kind: 'conclusion', title: 'Raising the default limit did not reduce throttling tickets', verdict: 'bad',
  why: 'Ticket volume was flat four weeks after the change; the real cause turned out to be an undocumented burst limit, not the steady-state ceiling.',
  links: [{ type: 'evaluates', to: a5 }, { type: 'refutes', to: t5 }],
});
await log(codex, {
  kind: 'rule', title: 'API rate-limit changes must ship with updated docs',
  why: "Raising the limit didn't help because customers didn't know the real constraint was the undocumented burst limit, not the published one.",
  links: [{ type: 'derived_from', to: c5 }],
});
// left proposed on purpose

// --- support inbox: canned auto-reply ---
const t6 = await log(claudeCode, { kind: 'thought', title: 'A canned auto-reply macro will cut first-response-time complaints', why: '', confidence: 0.6 });
const a6 = await log(claudeCode, {
  kind: 'action', title: 'Turned on a canned-macro auto-reply for the support inbox',
  why: 'First-response time was the top complaint in support CSAT comments; an immediate acknowledgment buys time for a real reply.',
  alternatives: ['hire a part-time support responder instead', 'only auto-reply outside business hours'],
  evidence: ['support CSAT comments, 1 month'],
  files: ['apps/api/support/autoReply.ts'],
  links: [{ type: 'motivated_by', to: t6 }],
});
const c6 = await log(claudeCode, {
  kind: 'conclusion', title: 'Auto-reply cut first-response complaints', verdict: 'good',
  why: 'First-response-time complaints in CSAT comments dropped after the auto-reply shipped.',
  links: [{ type: 'evaluates', to: a6 }, { type: 'supports', to: t6 }],
});
const r6 = await log(claudeCode, {
  kind: 'rule', title: 'Support auto-replies must include a human-reply ETA',
  why: 'The auto-reply helped, but a few customers replied asking when a real person would follow up; naming an ETA should close that gap.',
  links: [{ type: 'derived_from', to: c6 }],
});
await approveIfNeeded(r6, 'jordan');
await log(claudeCode, {
  kind: 'action', title: 'Added an ETA line to the canned support auto-reply macro',
  why: "Directly closes the gap the auto-reply's own conclusion pointed at.",
  files: ['apps/api/support/autoReply.ts'],
  links: [{ type: 'follows', to: a6 }, { type: 'complies_with', to: r6 }],
});
await log(claudeCode, {
  kind: 'thought', title: 'An ETA line might help the onboarding drop-off email too', why: '', confidence: 0.35,
  links: [{ type: 'derived_from', to: c6 }],
});

// --- pricing page: live chat widget, refuted ---
const t7 = await log(codex, { kind: 'thought', title: 'A live chat widget on the pricing page will lift trial signups', why: '', confidence: 0.5 });
const a7 = await log(codex, {
  kind: 'action', title: 'Added a live chat widget to the pricing page',
  why: 'Sales believed real-time answers to plan questions were the main blocker between pricing page and trial signup.',
  alternatives: ['add an FAQ accordion instead of live chat', "add a 'book a call' link instead of chat"],
  evidence: ['pricing page exit survey, 3 weeks'],
  files: ['apps/web/pricing/page.tsx', 'apps/web/components/ChatWidget.tsx'],
  links: [{ type: 'motivated_by', to: t7 }],
});
await log(codex, {
  kind: 'conclusion', title: 'Chat widget did not lift trial signups', verdict: 'bad',
  why: 'Trial signups were flat over three weeks; most chat volume was existing customers asking support questions, not prospects.',
  links: [{ type: 'evaluates', to: a7 }, { type: 'refutes', to: t7 }],
});

// --- self-serve downgrade ---
const t8 = await log(claudeCode, { kind: 'thought', title: 'Hiding the downgrade option behind support chat inflates churn-save cost', why: '', confidence: 0.55 });
const a8 = await log(claudeCode, {
  kind: 'action', title: 'Added a self-serve downgrade button to account settings',
  why: 'Every downgrade required a support conversation, which cost agent time and delayed the change for the customer.',
  alternatives: ['keep downgrade behind chat but add a canned macro', 'let downgrade happen automatically at renewal with an email notice'],
  evidence: ['support time log, downgrade tag, 1 month'],
  files: ['apps/web/settings/BillingPanel.tsx', 'apps/api/billing/downgrade.ts'],
  links: [{ type: 'motivated_by', to: t8 }],
});
const c8 = await log(claudeCode, {
  kind: 'conclusion', title: 'Self-serve downgrade cut support cost but raised short-term downgrade rate', verdict: 'mixed',
  why: 'Agent time on downgrades dropped, but the downgrade rate ticked up in the first two weeks before leveling off.',
  links: [{ type: 'evaluates', to: a8 }, { type: 'supports', to: t8 }],
});
const r8 = await log(claudeCode, {
  kind: 'rule', title: 'Self-serve downgrade must show a retention offer before confirming',
  why: 'The downgrade rate bump in the first two weeks suggests some of those were impulse clicks a retention offer could catch.',
  links: [{ type: 'derived_from', to: c8 }],
});
await approveIfNeeded(r8, 'jordan');
await log(claudeCode, {
  kind: 'action', title: 'Added a one-step retention offer to the self-serve downgrade flow',
  why: 'Directly implements the rule the downgrade conclusion led to.',
  files: ['apps/web/settings/BillingPanel.tsx'],
  links: [{ type: 'follows', to: a8 }, { type: 'complies_with', to: r8 }],
});

// --- public API changelog ---
const t9 = await log(codex, { kind: 'thought', title: 'Undocumented breaking API changes cause support spikes', why: '', confidence: 0.7 });
const a9 = await log(codex, {
  kind: 'action', title: 'Started publishing a public API changelog',
  why: 'Every breaking change before this shipped silently; customers found out from a broken integration instead of a heads-up.',
  alternatives: ['email customers directly instead of a public changelog', 'version the API instead of documenting changes'],
  evidence: ["support tickets tagged 'unexpected change', 2 months"],
  files: ['apps/api/docs/changelog.md', 'apps/web/docs/ChangelogPage.tsx'],
  links: [{ type: 'motivated_by', to: t9 }],
});
const c9 = await log(codex, {
  kind: 'conclusion', title: 'Public changelog reduced breaking-change support spikes', verdict: 'good',
  why: "Tickets tagged 'unexpected change' dropped after the changelog started shipping alongside breaking releases.",
  links: [{ type: 'evaluates', to: a9 }, { type: 'supports', to: t9 }],
});
await log(codex, {
  kind: 'thought', title: 'A changelog RSS feed might replace the manual status-page email blast', why: '', confidence: 0.3,
  links: [{ type: 'derived_from', to: c9 }],
});

// --- trial length ---
const t10 = await log(claudeCode, { kind: 'thought', title: '7-day trials are too short to reach the aha-moment for team accounts', why: '', confidence: 0.65 });
const a10 = await log(claudeCode, {
  kind: 'action', title: 'Extended trial length to 14 days for team-plan signups',
  why: "Usage data showed team accounts didn't invite a second teammate, the activation moment, until day 9 on average.",
  alternatives: ['keep 7 days but send a 3-day extension offer to inactive trials', 'extend trial length for all plans, not just team'],
  evidence: ['trial activation timing report, team plan'],
  files: ['apps/api/billing/trial.ts'],
  links: [{ type: 'motivated_by', to: t10 }],
});
const c10 = await log(claudeCode, {
  kind: 'conclusion', title: '14-day trials raised team-plan activation', verdict: 'good',
  why: 'Second-teammate-invite rate within the trial window rose after the extension shipped.',
  links: [{ type: 'evaluates', to: a10 }, { type: 'supports', to: t10 }],
});
const r10 = await log(claudeCode, {
  kind: 'rule', title: 'Team-plan trials must be at least 14 days',
  why: 'The extension raised activation; shortening it back would undo that.',
  links: [{ type: 'derived_from', to: c10 }],
});
await approveIfNeeded(r10, 'jordan');
await log(claudeCode, {
  kind: 'action', title: 'Applied the 14-day trial rule to the enterprise-lite plan',
  why: 'Enterprise-lite is priced and used like the team plan, so it should carry the same trial-length rule.',
  files: ['apps/api/billing/trial.ts'],
  links: [{ type: 'follows', to: a10 }, { type: 'complies_with', to: r10 }],
});

// --- standalone compliance actions ---
await log(claudeCode, {
  kind: 'action', title: 'Refunded a customer on day 10 of their subscription',
  why: 'Within the 14-day refund window.',
  files: ['apps/api/billing/refunds.ts'],
  links: [{ type: 'complies_with', to: refund }],
});
await log(claudeCode, {
  kind: 'action', title: 'Sent a trial-ending reminder email with no specific ship date for the next feature',
  why: 'Avoids promising a date support would have to walk back if the feature slips.',
  files: ['apps/api/email/templates/trialEnding.ts'],
  links: [{ type: 'complies_with', to: shipDateGuard }],
});

const nodeCount = (getDb().prepare('SELECT COUNT(*) AS c FROM node').get() as { c: number }).c;
const edgeCount = (getDb().prepare('SELECT COUNT(*) AS c FROM edge').get() as { c: number }).c;
console.log(`seed complete -> ${DB_PATH} (${nodeCount} nodes, ${edgeCount} edges)`);
