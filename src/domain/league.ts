/** A private Premier League fantasy league, joined by invite code only. */
export interface League {
  id: string;
  name: string;
  inviteCode: string;
  commissionerUserId: string;
  /** Once true, the commissioner can no longer change league settings (season has started). */
  areSettingsLocked: boolean;
  createdAt: Date;
}
