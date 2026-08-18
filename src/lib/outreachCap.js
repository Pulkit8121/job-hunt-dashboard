// Shared daily-send accounting for a single Gmail identity. Cold outreach
// (bulk queue + manual one-offs) and relocation follow-ups all draw against
// the SAME per-identity sending reputation/quota, so every place that checks
// "how many has this identity sent today" must count all of them together —
// otherwise a cap meant to be one ceiling per identity silently becomes two.
export function isToday(date) {
  if (!date) return false;
  const d = new Date(date);
  const now = new Date();
  return d.toDateString() === now.toDateString();
}

export function countSentToday(contacts, identityId) {
  return contacts.filter(c => c.sentFromIdentity === identityId && (
    (c.status === 'sent' && isToday(c.sentAt)) ||
    isToday(c.followUpSentAt)
  )).length;
}

// Absolute ceiling on real emails sent per day, regardless of a higher
// per-identity dailyLimit setting — a personal Gmail account's hard technical
// limit is ~500 recipients/day, and crossing it gets sends blocked. Not
// env-configurable so a stale/huge value can't silently blow past Gmail's
// limit and freeze the account.
export const HARD_MAX_DAILY_SENDS = 400;

export function getDailyCap(settings) {
  return Math.min(Number(settings?.dailyLimit) || 150, HARD_MAX_DAILY_SENDS);
}
