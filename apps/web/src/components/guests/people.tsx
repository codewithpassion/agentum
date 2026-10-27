/** biome-ignore-all lint/performance/noJsxPropsBind: People actions bind the selected grant. */
import { useCallback, useEffect, useState } from "react";
import { getTrpc } from "#/integrations/trpc/client";

type People = Awaited<
  ReturnType<ReturnType<typeof getTrpc>["liveGuests"]["people"]["query"]>
>;
export function GuestPeople({ artifactId }: { artifactId: string }) {
  const [data, setData] = useState<People>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"viewer" | "commenter" | "editor">("viewer");
  const [days, setDays] = useState("7");
  const [date, setDate] = useState("");
  const [cap, setCap] = useState(20);
  const load = useCallback(
    () => getTrpc().liveGuests.people.query({ artifactId }).then(setData),
    [artifactId]
  );
  useEffect(() => {
    load().catch((cause: Error) => setError(cause.message));
  }, [load]);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "People update failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="People">
      <h3>People</h3>
      {Boolean(error) && <p role="alert">{error}</p>}
      {Boolean(data?.canSwitch) && (
        <label>
          <input
            checked={data.enabled}
            disabled={busy}
            onChange={(event) =>
              run(() =>
                getTrpc().liveGuests.setEnabled.mutate({
                  enabled: event.target.checked,
                })
              )
            }
            type="checkbox"
          />
          Guests can be invited in this workspace
        </label>
      )}
      {Boolean(data) && (
        <>
          {!data.enabled && <p>Guest access is off for this workspace.</p>}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              run(async () => {
                const expiresAt =
                  days === "date"
                    ? new Date(date).toISOString()
                    : new Date(
                        Date.now() + Number(days) * 86_400_000
                      ).toISOString();
                await getTrpc().liveGuests.invite.mutate({
                  agentRunsPerDay: cap,
                  artifactId,
                  email,
                  expiresAt,
                  role,
                });
                setEmail("");
              });
            }}
          >
            <label>
              Email
              <input
                onChange={(event) => setEmail(event.target.value)}
                required
                type="email"
                value={email}
              />
            </label>
            <label>
              Role
              <select
                onChange={(event) => setRole(event.target.value as typeof role)}
                value={role}
              >
                <option>viewer</option>
                <option>commenter</option>
                <option>editor</option>
              </select>
            </label>
            <label>
              Expiry
              <select
                onChange={(event) => setDays(event.target.value)}
                value={days}
              >
                <option value="1">1 day</option>
                <option value="7">7 days</option>
                <option value="30">30 days</option>
                <option value="date">Choose a date</option>
              </select>
            </label>
            {days === "date" && (
              <label>
                Access ends
                <input
                  onChange={(event) => setDate(event.target.value)}
                  required
                  type="datetime-local"
                  value={date}
                />
              </label>
            )}
            <label>
              Daily agent cap
              <input
                max={1000}
                min={0}
                onChange={(event) => setCap(Number(event.target.value))}
                required
                type="number"
                value={cap}
              />
            </label>
            <p>
              Guest agent execution is currently unavailable. The cap applies
              when restricted execution ships.
            </p>
            <button disabled={busy} type="submit">
              Send invitation
            </button>
          </form>
          {data.grants.map((grant) => (
            <div key={grant.id}>
              <p>
                {grant.email ?? grant.userId} · {grant.principalKind} ·{" "}
                {grant.expiresAt
                  ? new Date(grant.expiresAt).toLocaleString()
                  : "No expiry"}{" "}
                · {grant.agentRunsPerDay} runs/day
              </p>
              <label>
                Role
                <select
                  disabled={busy}
                  onChange={(event) =>
                    run(() =>
                      getTrpc().liveGuests.changeRole.mutate({
                        artifactId,
                        memberId: grant.id,
                        role: event.target.value as typeof role,
                      })
                    )
                  }
                  value={grant.role}
                >
                  <option>viewer</option>
                  <option>commenter</option>
                  <option>editor</option>
                </select>
              </label>
              <button
                disabled={busy}
                onClick={() =>
                  run(() =>
                    getTrpc().liveGuests.revoke.mutate({
                      artifactId,
                      memberId: grant.id,
                    })
                  )
                }
                type="button"
              >
                Revoke access
              </button>
            </div>
          ))}
        </>
      )}
    </section>
  );
}
