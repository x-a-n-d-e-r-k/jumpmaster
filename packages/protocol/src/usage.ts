// Usage windows and the rate-limit event Claude reports, shared by drops and the chat.
import { z } from 'zod';

/** A usage window's key as the account reports it: `five_hour`, `seven_day`, `seven_day_fable`... */
export const USAGE_WINDOW_KEY = /^[a-z0-9_]{1,40}$/;
const IsoSchema = z.iso.datetime({ offset: true });
export const UsageWindowSchema = z.object({
  utilization: z.number().min(0).max(1),
  resetsAt: IsoSchema.optional(),
});
export type UsageWindow = z.infer<typeof UsageWindowSchema>;
export type UsageWindows = Record<string, UsageWindow>;

const isoOnly = (v: unknown): string | undefined =>
  IsoSchema.safeParse(v).success ? (v as string) : undefined;

/**
 * Every valid window of a reported `unifiedWindows` object (#144). A key not matching
 * USAGE_WINDOW_KEY, or a utilization outside 0..1, drops that window; a reset time that
 * `normalize` cannot make an ISO timestamp drops only the reset. Never throws.
 */
export function usageWindowsOf(
  v: unknown,
  normalize: (resetsAt: unknown) => string | undefined = isoOnly,
): UsageWindows | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const out: UsageWindows = {};
  for (const [key, w] of Object.entries(v as Record<string, unknown>)) {
    if (!USAGE_WINDOW_KEY.test(key) || typeof w !== 'object' || w === null) continue;
    const raw = w as Record<string, unknown>;
    const resetsAt = isoOnly(normalize(raw.resetsAt ?? raw.resets_at));
    const parsed = UsageWindowSchema.safeParse({
      utilization: raw.utilization,
      ...(resetsAt ? { resetsAt } : {}),
    });
    if (parsed.success) out[key] = parsed.data;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export const RateLimitEventDataSchema = z.object({
  status: z.enum(['allowed', 'allowed_warning', 'rejected']),
  resetsAt: z.string().optional(),
  rateLimitType: z.string().optional(),
  /** Every window the account reports, keyed as reported; bad entries are dropped, not refused. */
  unifiedWindows: z
    .preprocess((v) => usageWindowsOf(v), z.record(z.string(), UsageWindowSchema).optional())
    .optional(),
  /** Unobserved field names, kept as sent (pending rehearsal). */
  isUsingOverage: z.boolean().optional(),
  overageStatus: z.string().optional(),
  /** When the extra-usage spending cap resets (monthly); never a usage window's reset. */
  overageResetsAt: z.string().optional(),
});
export type RateLimitEventData = z.infer<typeof RateLimitEventDataSchema>;
