import { Database, type SQLQueryBindings } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createDb, type Db } from "#/db/client";
import {
  linkExternalAuthor,
  listExternalAuthors,
  rememberExternalAuthor,
  resolveExternalAuthors,
} from "./external-authors";

/**
 * Who a bridged message is from. The interesting cases are the ones where the
 * two halves disagree - a name with nobody behind it, a link whose membership
 * is gone, and the same Slack person in two workspaces.
 */

const migrationsDir = new URL("../../../drizzle/", import.meta.url);

const createTestD1 = (): D1Database => {
  const journal = JSON.parse(
    readFileSync(new URL("meta/_journal.json", migrationsDir), "utf8")
  ) as { entries: { tag: string }[] };

  const sqlite = new Database(":memory:");
  for (const entry of journal.entries) {
    const sql = readFileSync(
      new URL(`${entry.tag}.sql`, migrationsDir),
      "utf8"
    );
    for (const statement of sql.split("--> statement-breakpoint")) {
      sqlite.exec(statement);
    }
  }

  return {
    batch: (statements: { all: () => Promise<unknown> }[]) =>
      Promise.all(statements.map((statement) => statement.all())),
    prepare: (query: string) => {
      const stmt = sqlite.query(query);
      return {
        bind: (...params: SQLQueryBindings[]) => ({
          all: () => Promise.resolve({ results: stmt.all(...params) }),
          raw: () => Promise.resolve(stmt.values(...params)),
          run: () => Promise.resolve(stmt.run(...params)),
        }),
      };
    },
  } as unknown as D1Database;
};

const WORKSPACE = "ws_alpha";
const OTHER_WORKSPACE = "ws_beta";
const AUTHOR = "slack:U0AHBBYVAN5";

let db: Db;

const addMember = async (
  workspaceId: string,
  member: { email: string; id: string; name: string }
) => {
  await db.run(
    `insert into workspace_members (id, workspace_id, clerk_user_id, email, name, role)
     values ('${member.id}', '${workspaceId}', 'user_${member.id}', '${member.email}', '${member.name}', 'member')`
  );
};

const link = async (workspaceId: string, memberId: string | null) => {
  await db.run(
    `update external_authors set member_id = ${memberId ? `'${memberId}'` : "null"}, link_source = 'manual'
     where workspace_id = '${workspaceId}' and author_id = '${AUTHOR}'`
  );
};

beforeEach(() => {
  db = createDb(createTestD1());
});

describe("rememberExternalAuthor", () => {
  test("reports the first sighting once, and never again", async () => {
    const first = await rememberExternalAuthor(db, WORKSPACE, {
      authorId: AUTHOR,
      displayName: "Dominik",
    });
    const second = await rememberExternalAuthor(db, WORKSPACE, {
      authorId: AUTHOR,
      displayName: "Dominik",
    });

    // The email match rides on this: one Slack call per person, not per message.
    expect([first.firstSighting, second.firstSighting]).toEqual([true, false]);
  });

  test("the same person is a first sighting in each workspace", async () => {
    await rememberExternalAuthor(db, WORKSPACE, {
      authorId: AUTHOR,
      displayName: "Dominik",
    });
    const other = await rememberExternalAuthor(db, OTHER_WORKSPACE, {
      authorId: AUTHOR,
      displayName: "Dominik",
    });

    expect(other.firstSighting).toBe(true);
  });
});

describe("linkExternalAuthor", () => {
  const seen = () =>
    rememberExternalAuthor(db, WORKSPACE, {
      authorId: AUTHOR,
      displayName: "Dominik",
    });

  const linkedTo = async () =>
    (await listExternalAuthors(db, WORKSPACE))[0]?.memberId;

  test("the email match links somebody nobody has decided about", async () => {
    await seen();
    await linkExternalAuthor(db, WORKSPACE, {
      authorId: AUTHOR,
      linkSource: "auto",
      memberId: "mem_1",
    });

    expect(await linkedTo()).toBe("mem_1");
  });

  test("the email match never overrules a correction made by hand", async () => {
    await seen();
    await linkExternalAuthor(db, WORKSPACE, {
      authorId: AUTHOR,
      linkSource: "manual",
      memberId: "mem_1",
    });

    await linkExternalAuthor(db, WORKSPACE, {
      authorId: AUTHOR,
      linkSource: "auto",
      memberId: "mem_2",
    });

    expect(await linkedTo()).toBe("mem_1");
  });

  test("a correction to nobody sticks, rather than being matched again", async () => {
    await seen();
    await linkExternalAuthor(db, WORKSPACE, {
      authorId: AUTHOR,
      linkSource: "manual",
      memberId: null,
    });

    await linkExternalAuthor(db, WORKSPACE, {
      authorId: AUTHOR,
      linkSource: "auto",
      memberId: "mem_2",
    });

    // "This is nobody" is an answer, and the match must not talk over it.
    expect(await linkedTo()).toBeNull();
  });

  test("somebody by hand replaces what the email match guessed", async () => {
    await seen();
    await linkExternalAuthor(db, WORKSPACE, {
      authorId: AUTHOR,
      linkSource: "auto",
      memberId: "mem_1",
    });

    await linkExternalAuthor(db, WORKSPACE, {
      authorId: AUTHOR,
      linkSource: "manual",
      memberId: "mem_2",
    });

    expect(await linkedTo()).toBe("mem_2");
  });
});

describe("resolveExternalAuthors", () => {
  test("names somebody nobody has linked yet", async () => {
    await rememberExternalAuthor(db, WORKSPACE, {
      authorId: AUTHOR,
      displayName: "Dominik",
    });

    const resolved = await resolveExternalAuthors(db, WORKSPACE, [AUTHOR]);

    expect(resolved.get(AUTHOR)).toEqual({
      email: null,
      imageUrl: null,
      memberId: null,
      name: "Dominik",
    });
  });

  test("answers for nobody it has never seen", async () => {
    const resolved = await resolveExternalAuthors(db, WORKSPACE, [
      "routine:rt_1",
      AUTHOR,
    ]);

    // A miss is the normal case, and the client labels those itself.
    expect(resolved.size).toBe(0);
  });

  test("keeps the newest display name a message arrived under", async () => {
    await rememberExternalAuthor(db, WORKSPACE, {
      authorId: AUTHOR,
      displayName: "Dominik",
    });
    await rememberExternalAuthor(db, WORKSPACE, {
      authorId: AUTHOR,
      displayName: "Dominik Fretz",
    });

    const resolved = await resolveExternalAuthors(db, WORKSPACE, [AUTHOR]);
    expect(resolved.get(AUTHOR)?.name).toBe("Dominik Fretz");
  });

  test("resolves a linked author to the member, avatar and id", async () => {
    await addMember(WORKSPACE, {
      email: "dominik@example.com",
      id: "mem_1",
      name: "Dominik Fretz",
    });
    await rememberExternalAuthor(db, WORKSPACE, {
      authorId: AUTHOR,
      displayName: "dominik",
    });
    await link(WORKSPACE, "mem_1");

    const resolved = await resolveExternalAuthors(db, WORKSPACE, [AUTHOR]);

    expect(resolved.get(AUTHOR)?.memberId).toBe("mem_1");
    expect(resolved.get(AUTHOR)?.name).toBe("Dominik Fretz");
  });

  test("a later name does not disturb a link somebody made by hand", async () => {
    await addMember(WORKSPACE, {
      email: "dominik@example.com",
      id: "mem_1",
      name: "Dominik Fretz",
    });
    await rememberExternalAuthor(db, WORKSPACE, {
      authorId: AUTHOR,
      displayName: "dominik",
    });
    await link(WORKSPACE, "mem_1");

    await rememberExternalAuthor(db, WORKSPACE, {
      authorId: AUTHOR,
      displayName: "dom",
    });

    expect(
      (await resolveExternalAuthors(db, WORKSPACE, [AUTHOR])).get(AUTHOR)
    ).toMatchObject({ memberId: "mem_1", name: "Dominik Fretz" });
  });

  test("falls back to the surface name when the membership is gone", async () => {
    await rememberExternalAuthor(db, WORKSPACE, {
      authorId: AUTHOR,
      displayName: "Dominik",
    });
    // Linked, then removed from the workspace: "Former member" would throw away
    // the one name we still have for them.
    await link(WORKSPACE, "mem_deleted");

    expect(
      (await resolveExternalAuthors(db, WORKSPACE, [AUTHOR])).get(AUTHOR)
    ).toEqual({
      email: null,
      imageUrl: null,
      memberId: null,
      name: "Dominik",
    });
  });

  test("one Slack person is two people in two workspaces", async () => {
    await addMember(WORKSPACE, {
      email: "dominik@example.com",
      id: "mem_1",
      name: "Dominik Fretz",
    });
    await rememberExternalAuthor(db, WORKSPACE, {
      authorId: AUTHOR,
      displayName: "dominik",
    });
    await link(WORKSPACE, "mem_1");
    await rememberExternalAuthor(db, OTHER_WORKSPACE, {
      authorId: AUTHOR,
      displayName: "dominik",
    });

    // The link belongs to the workspace it was made in, and must not leak.
    expect(
      (await resolveExternalAuthors(db, OTHER_WORKSPACE, [AUTHOR])).get(AUTHOR)
        ?.memberId
    ).toBeNull();
  });
});
