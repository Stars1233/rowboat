import { CronExpressionParser } from 'cron-parser';
import type { Trigger } from '@x/shared/dist/track.js';

const GRACE_MS = 2 * 60 * 1000; // 2 minutes

/** Subset of Trigger that fires on a clock — the schedulable types. */
export type TimedTrigger = Extract<Trigger, { type: 'cron' | 'window' | 'once' }>;

/**
 * Determine if a timed trigger is due to fire.
 *
 * - `cron` and `once` enforce a 2-minute grace window — if the scheduled time
 *   was more than 2 minutes ago, it's considered a miss and skipped (avoids
 *   replay storms after the app was offline at the trigger time).
 * - `window` is forgiving: it fires at most once per day, anywhere inside the
 *   configured time-of-day band. The day's cycle is anchored at `startTime` —
 *   once a fire lands at-or-after today's startTime, the trigger is done for
 *   the day. Use this for tracks that should "happen sometime in the morning"
 *   rather than "at exactly 8:00am."
 */
export function isTriggerDue(schedule: TimedTrigger, lastRunAt: string | null): boolean {
    const now = new Date();

    switch (schedule.type) {
        case 'cron': {
            if (!lastRunAt) return true; // Never ran — immediately due
            try {
                // Find the MOST RECENT occurrence at-or-before `now`, not the
                // occurrence right after lastRunAt. If lastRunAt is old, that
                // occurrence would be ancient too and always fall outside the
                // grace window, blocking every future fire.
                const interval = CronExpressionParser.parse(schedule.expression, {
                    currentDate: now,
                });
                const prevRun = interval.prev().toDate();

                // Already ran at-or-after this occurrence → skip.
                if (new Date(lastRunAt).getTime() >= prevRun.getTime()) return false;

                // Within grace → fire. Outside grace → missed, skip.
                return now.getTime() <= prevRun.getTime() + GRACE_MS;
            } catch {
                return false;
            }
        }
        case 'window': {
            // Must be inside the time-of-day band.
            const [startHour, startMin] = schedule.startTime.split(':').map(Number);
            const [endHour, endMin] = schedule.endTime.split(':').map(Number);
            const startMinutes = startHour * 60 + startMin;
            const endMinutes = endHour * 60 + endMin;
            const nowMinutes = now.getHours() * 60 + now.getMinutes();
            if (nowMinutes < startMinutes || nowMinutes > endMinutes) return false;

            if (!lastRunAt) return true;

            // Daily cycle anchored at startTime. If we've already fired
            // strictly after today's startTime, skip until tomorrow. The
            // strict comparison (>, not >=) means a fire happening exactly
            // at a window boundary belongs to the earlier window — so two
            // adjacent windows sharing an endpoint (e.g. 08–12 and 12–15)
            // each still get their own fire on the same day.
            const cycleStart = new Date(now);
            cycleStart.setHours(startHour, startMin, 0, 0);
            if (new Date(lastRunAt).getTime() > cycleStart.getTime()) return false;
            return true;
        }
        case 'once': {
            if (lastRunAt) return false; // Already ran
            const runAt = new Date(schedule.runAt);
            return now >= runAt && now.getTime() <= runAt.getTime() + GRACE_MS;
        }
    }
}
