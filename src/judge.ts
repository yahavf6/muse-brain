export type Question =
  | { type: 'noul'; instructions: string; criteria?: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: string; criteria: string[] };

export type Answer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; probabilities: Record<string, number>; confidence: number };

export function jevEnabled(): boolean {
  if (process.env.BRAIN_JEV === 'off') return false;
  return !!process.env.TYPESAFE_API_KEY;
}

export async function judge(
  state: unknown,
  questions: Record<string, Question>,
  timeoutMs: number,
): Promise<Record<string, Answer> | null> {
  if (!jevEnabled()) return null;
  try {
    const res = await fetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.TYPESAFE_API_KEY}` },
      body: JSON.stringify({ state, model: process.env.JEV_MODEL ?? 'jev-1.13.0', questions }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    // The body is { model, answers: {<id>: Answer}, usage }; callers only want the answers map.
    const body = (await res.json()) as { answers?: Record<string, Answer> } | null;
    return body?.answers ?? null;
  } catch {
    return null;
  }
}
