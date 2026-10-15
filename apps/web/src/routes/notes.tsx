import { NOTE_TEXT_MAX_LENGTH } from "@repo/db/shared";
import {
  createFileRoute,
  type ErrorComponentProps,
  useRouter,
} from "@tanstack/react-router";
import { type ChangeEvent, type FormEvent, useCallback, useState } from "react";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { getTrpc } from "#/integrations/trpc/client";

export const Route = createFileRoute("/notes")({
  loader: () => getTrpc().notes.list.query(),
  component: NotesPage,
  errorComponent: NotesError,
});

function NotesPage() {
  const notes = Route.useLoaderData();
  const router = useRouter();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleTextChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setText(event.target.value),
    []
  );

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setSaving(true);
      setError(null);
      try {
        await getTrpc().notes.create.mutate({ text });
        setText("");
        await router.invalidate();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not save note.");
      } finally {
        setSaving(false);
      }
    },
    [router, text]
  );

  return (
    <main className="page-wrap px-4 py-12">
      <section className="max-w-3xl">
        <p className="island-kicker mb-3">Cloudflare D1</p>
        <h1 className="display-title mb-4 text-4xl text-foreground sm:text-5xl">
          Notes
        </h1>
        <p className="m-0 max-w-3xl text-base text-muted-foreground leading-8">
          A minimal round trip: a tRPC procedure reads and writes a{" "}
          <code>notes</code> table through <code>@repo/services</code>. Add a
          note and it lands in the D1 database bound as <code>DB</code>.
        </p>
      </section>

      <form className="island-shell mt-10 p-6 sm:p-8" onSubmit={handleSubmit}>
        <label className="island-kicker mb-3 block" htmlFor="note-text">
          New note
        </label>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Input
            id="note-text"
            maxLength={NOTE_TEXT_MAX_LENGTH}
            onChange={handleTextChange}
            placeholder="What's on your mind?"
            required
            value={text}
          />
          <Button disabled={saving || text.trim().length === 0} type="submit">
            {saving ? "Saving…" : "Add note"}
          </Button>
        </div>
        {error ? (
          <p className="mt-3 text-destructive text-sm" role="alert">
            {error}
          </p>
        ) : null}
      </form>

      <section className="mt-10">
        {notes.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No notes yet. Add the first one above.
          </p>
        ) : (
          <ul className="m-0 list-none space-y-4 p-0">
            {notes.map((note) => (
              <li className="border-border border-t pt-4" key={note.id}>
                <p className="m-0 text-foreground">{note.text}</p>
                <time
                  className="text-muted-foreground text-xs"
                  dateTime={note.createdAt}
                >
                  {formatUtc(note.createdAt)}
                </time>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

// Same output on the Worker and in the browser. `toLocaleString()` would differ
// by locale and timezone and cause a hydration mismatch.
function formatUtc(iso: string): string {
  return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

function NotesError({ error }: ErrorComponentProps) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <main className="page-wrap px-4 py-12">
      <section className="island-shell max-w-3xl p-6 sm:p-8">
        <p className="island-kicker mb-3">Cloudflare D1</p>
        <h1 className="display-title mb-4 text-3xl text-foreground">
          Could not reach D1
        </h1>
        <p className="m-0 text-muted-foreground text-sm leading-7">
          Locally this usually means the migrations have not been applied:{" "}
          <code>bun run dev</code> does that on start. On a deployed Worker,
          check that <code>database_id</code> in <code>wrangler.jsonc</code>{" "}
          names a real database and that{" "}
          <code>wrangler d1 migrations apply DB --remote</code> has been run.
        </p>
        <pre className="mt-4 overflow-x-auto rounded-md bg-muted p-3 text-xs">
          {message}
        </pre>
      </section>
    </main>
  );
}
