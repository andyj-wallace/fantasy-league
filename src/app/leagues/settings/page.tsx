"use client";

import { Suspense, useEffect, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { authedFetch, fetchJson } from "@/app/lib/apiFetch";
import { getApiBaseUrl } from "@/app/lib/apiBaseUrl";
import { getStoredUserId } from "@/app/lib/auth";
import { useRequireAuth } from "@/app/lib/useRequireAuth";
import { LeagueInviteRow } from "@/app/components/LeagueInviteRow";
import { LoadingState } from "@/app/components/LoadingState";
import { IS_COMMISSIONERSHIP_TRANSFER_ENABLED, type League } from "@/domain";

interface LeagueMember {
  userId: string;
  displayName: string;
  teamId: string;
  teamName: string;
  isCommissioner: boolean;
}

type SectionMessage = { kind: "success" | "error"; text: string } | null;

/** Commissioner-only League Settings screen — rename, invite code, members/remove, settings
 * lock, and (behind IS_COMMISSIONERSHIP_TRANSFER_ENABLED, currently off) ownership transfer.
 * Addressed by ?leagueId= for the same static-export reason as /leagues (see that page's
 * comment): runtime UUIDs can't be enumerated as static paths. */
export default function LeagueSettingsPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <LeagueSettingsPageContent />
    </Suspense>
  );
}

function LeagueSettingsPageContent() {
  useRequireAuth();
  const searchParams = useSearchParams();
  const leagueId = searchParams.get("leagueId") ?? "";
  const router = useRouter();

  const [league, setLeague] = useState<League | null>(null);
  const [members, setMembers] = useState<LeagueMember[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function loadLeague() {
    try {
      const result = await fetchJson<Partial<League>>(`${getApiBaseUrl()}/leagues/${leagueId}`);
      if (!result.id) {
        setLoadError("League not found.");
        return;
      }
      setLeague(result as League);
    } catch {
      setLoadError("Could not load this league — try refreshing.");
    }
  }

  async function loadMembers() {
    try {
      const result = await fetchJson<{ members: LeagueMember[] }>(`${getApiBaseUrl()}/leagues/${leagueId}/members`);
      setMembers(result.members);
    } catch {
      setLoadError("Could not load this league's members — try refreshing.");
    }
  }

  useEffect(() => {
    if (!leagueId) {
      setLoadError("No league specified — open a league from your home page.");
      return;
    }
    loadLeague();
    loadMembers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leagueId]);

  if (loadError) return <main><p className="msg msg-error">{loadError}</p></main>;
  if (!league || !members) return <LoadingState />;

  if (getStoredUserId() !== league.commissionerUserId) {
    return (
      <main>
        <p className="msg msg-error">You're not the commissioner of this league.</p>
        <div className="link-list">
          <Link href={`/leagues?leagueId=${leagueId}`}>Back to league</Link>
        </div>
      </main>
    );
  }

  return (
    <main>
      <div className="page-header">
        <h1>League Settings</h1>
      </div>

      <LeagueDetailsSection league={league} onRenamed={setLeague} />
      <InviteSection league={league} onRegenerated={setLeague} />
      <MembersSection leagueId={leagueId} members={members} onChanged={loadMembers} />
      {IS_COMMISSIONERSHIP_TRANSFER_ENABLED && (
        <OwnershipSection
          leagueId={leagueId}
          members={members}
          commissionerUserId={league.commissionerUserId}
          onTransferred={() => router.push(`/leagues?leagueId=${leagueId}`)}
        />
      )}
      <SettingsLockSection league={league} onToggled={setLeague} />

      <div className="link-list">
        <Link href={`/leagues?leagueId=${leagueId}`}>Back to league</Link>
      </div>
    </main>
  );
}

function LeagueDetailsSection({ league, onRenamed }: { league: League; onRenamed: (league: League) => void }) {
  const [name, setName] = useState(league.name);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<SectionMessage>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setIsSaving(true);
    try {
      const response = await authedFetch(`${getApiBaseUrl()}/leagues/${league.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const body = await response.json();
      if (!response.ok) {
        setMessage({ kind: "error", text: body.message ?? "Could not rename the league — try again." });
        return;
      }
      onRenamed(body);
      setMessage({ kind: "success", text: "League renamed." });
    } catch {
      setMessage({ kind: "error", text: "Could not rename the league — check your connection and try again." });
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <h2>League details</h2>
      {league.areSettingsLocked && (
        <p className="msg msg-warning">Settings are locked — unlock them below to rename this league.</p>
      )}
      <form className="form-stack" onSubmit={handleSubmit}>
        <label>
          League name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={league.areSettingsLocked || isSaving}
            required
          />
        </label>
        <button className="btn-primary" type="submit" disabled={league.areSettingsLocked || isSaving} style={{ maxWidth: 160 }}>
          {isSaving ? "Saving…" : "Rename"}
        </button>
      </form>
      {message && <p className={`msg ${message.kind === "success" ? "msg-success" : "msg-error"}`}>{message.text}</p>}
    </div>
  );
}

function InviteSection({ league, onRegenerated }: { league: League; onRegenerated: (league: League) => void }) {
  const [isConfirming, setIsConfirming] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [message, setMessage] = useState<SectionMessage>(null);

  async function handleConfirmedRegenerate() {
    setIsConfirming(false);
    setIsRegenerating(true);
    setMessage(null);
    try {
      const response = await authedFetch(`${getApiBaseUrl()}/leagues/${league.id}/invite-code/regenerate`, {
        method: "POST",
      });
      const body = await response.json();
      if (!response.ok) {
        setMessage({ kind: "error", text: body.message ?? "Could not regenerate the invite code — try again." });
        return;
      }
      onRegenerated(body);
      setMessage({ kind: "success", text: "Invite code regenerated — the old code no longer works." });
    } catch {
      setMessage({ kind: "error", text: "Could not regenerate the invite code — check your connection and try again." });
    } finally {
      setIsRegenerating(false);
    }
  }

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <h2>Invite</h2>
      <LeagueInviteRow league={league} />

      {!isConfirming && (
        <button onClick={() => setIsConfirming(true)} disabled={isRegenerating} style={{ marginTop: "0.75rem" }}>
          Regenerate invite code
        </button>
      )}
      {isConfirming && (
        <div className="card" style={{ marginTop: "0.75rem" }}>
          <p style={{ marginTop: 0 }}>Regenerating immediately invalidates the current invite code. Continue?</p>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button className="btn-danger" onClick={handleConfirmedRegenerate} disabled={isRegenerating}>
              {isRegenerating ? "Regenerating…" : "Confirm regenerate"}
            </button>
            <button onClick={() => setIsConfirming(false)} disabled={isRegenerating}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {message && <p className={`msg ${message.kind === "success" ? "msg-success" : "msg-error"}`}>{message.text}</p>}
    </div>
  );
}

function MembersSection({
  leagueId,
  members,
  onChanged,
}: {
  leagueId: string;
  members: LeagueMember[];
  onChanged: () => void;
}) {
  const [armedUserId, setArmedUserId] = useState<string | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);
  const [message, setMessage] = useState<SectionMessage>(null);

  async function handleConfirmedRemove(member: LeagueMember) {
    setIsRemoving(true);
    setMessage(null);
    try {
      const response = await authedFetch(`${getApiBaseUrl()}/leagues/${leagueId}/managers/${member.userId}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setMessage({ kind: "error", text: body.message ?? "Could not remove that manager — try again." });
        return;
      }
      setArmedUserId(null);
      onChanged();
      setMessage({ kind: "success", text: `${member.displayName} was removed.` });
    } catch {
      setMessage({ kind: "error", text: "Could not remove that manager — check your connection and try again." });
    } finally {
      setIsRemoving(false);
    }
  }

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <h2>Members</h2>
      <ul className="squad-list">
        {members.map((member) => (
          <li key={member.userId}>
            <span>
              {member.displayName} — {member.teamName}
            </span>
            {member.isCommissioner && <span className="badge badge-blue">Commissioner</span>}
            {!member.isCommissioner && armedUserId !== member.userId && (
              <button
                className="btn-danger"
                style={{ marginLeft: "auto" }}
                onClick={() => setArmedUserId(member.userId)}
                disabled={isRemoving}
              >
                Remove
              </button>
            )}
            {!member.isCommissioner && armedUserId === member.userId && (
              <span style={{ marginLeft: "auto", display: "flex", gap: "0.5rem", alignItems: "center" }}>
                <span>Remove {member.displayName}?</span>
                <button className="btn-danger" onClick={() => handleConfirmedRemove(member)} disabled={isRemoving}>
                  {isRemoving ? "Removing…" : "Confirm"}
                </button>
                <button onClick={() => setArmedUserId(null)} disabled={isRemoving}>
                  Cancel
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {message && <p className={`msg ${message.kind === "success" ? "msg-success" : "msg-error"}`}>{message.text}</p>}
    </div>
  );
}

function OwnershipSection({
  leagueId,
  members,
  commissionerUserId,
  onTransferred,
}: {
  leagueId: string;
  members: LeagueMember[];
  commissionerUserId: string;
  onTransferred: () => void;
}) {
  const candidates = members.filter((member) => member.userId !== commissionerUserId);
  const [selectedUserId, setSelectedUserId] = useState(candidates[0]?.userId ?? "");
  const [isConfirming, setIsConfirming] = useState(false);
  const [isTransferring, setIsTransferring] = useState(false);
  const [message, setMessage] = useState<SectionMessage>(null);

  const selectedMember = candidates.find((member) => member.userId === selectedUserId);

  async function handleConfirmedTransfer() {
    if (!selectedMember) return;
    setIsTransferring(true);
    setMessage(null);
    try {
      const response = await authedFetch(`${getApiBaseUrl()}/leagues/${leagueId}/transfer-commissionership`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newCommissionerUserId: selectedMember.userId }),
      });
      const body = await response.json();
      if (!response.ok) {
        setMessage({ kind: "error", text: body.message ?? "Could not transfer commissionership — try again." });
        return;
      }
      onTransferred();
    } catch {
      setMessage({ kind: "error", text: "Could not transfer commissionership — check your connection and try again." });
    } finally {
      setIsTransferring(false);
    }
  }

  if (candidates.length === 0) {
    return (
      <div className="card" style={{ marginBottom: "1rem" }}>
        <h2>Ownership</h2>
        <p>No other members to transfer commissionership to yet.</p>
      </div>
    );
  }

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <h2>Ownership</h2>
      <div className="form-stack">
        <label>
          New commissioner
          <select value={selectedUserId} onChange={(event) => setSelectedUserId(event.target.value)} disabled={isConfirming || isTransferring}>
            {candidates.map((member) => (
              <option key={member.userId} value={member.userId}>
                {member.displayName} — {member.teamName}
              </option>
            ))}
          </select>
        </label>
        {!isConfirming && (
          <button onClick={() => setIsConfirming(true)} disabled={isTransferring} style={{ maxWidth: 220 }}>
            Transfer commissionership
          </button>
        )}
        {isConfirming && (
          <div className="card">
            <p style={{ marginTop: 0 }}>
              Transfer commissionership to {selectedMember?.displayName}? You'll remain a manager but lose access to
              this settings screen.
            </p>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button className="btn-danger" onClick={handleConfirmedTransfer} disabled={isTransferring}>
                {isTransferring ? "Transferring…" : "Confirm transfer"}
              </button>
              <button onClick={() => setIsConfirming(false)} disabled={isTransferring}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
      {message && <p className={`msg ${message.kind === "success" ? "msg-success" : "msg-error"}`}>{message.text}</p>}
    </div>
  );
}

function SettingsLockSection({ league, onToggled }: { league: League; onToggled: (league: League) => void }) {
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<SectionMessage>(null);

  async function handleToggle() {
    setIsSaving(true);
    setMessage(null);
    try {
      const response = await authedFetch(`${getApiBaseUrl()}/leagues/${league.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ areSettingsLocked: !league.areSettingsLocked }),
      });
      const body = await response.json();
      if (!response.ok) {
        setMessage({ kind: "error", text: body.message ?? "Could not update the settings lock — try again." });
        return;
      }
      onToggled(body);
    } catch {
      setMessage({ kind: "error", text: "Could not update the settings lock — check your connection and try again." });
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <h2>Settings lock</h2>
      <p>
        A safety catch for once the season starts: while locked, renaming is rejected. Removing managers and
        regenerating the invite code always work regardless of this setting.
      </p>
      <button onClick={handleToggle} disabled={isSaving} style={{ maxWidth: 220 }}>
        {isSaving ? "Saving…" : league.areSettingsLocked ? "Unlock settings" : "Lock settings"}
      </button>
      {message && <p className={`msg ${message.kind === "success" ? "msg-success" : "msg-error"}`}>{message.text}</p>}
    </div>
  );
}
