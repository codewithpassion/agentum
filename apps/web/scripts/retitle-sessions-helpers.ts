import { conversationTitle, storedTitle } from "@repo/services/mail-title-text";

export interface RetitleRow {
  agentName: string | null;
  id: string;
  inputText: string | null;
  title: string | null;
}

export const SELECT_SESSIONS = `SELECT s.id, s.title, a.name AS agentName,
  (SELECT r.input_text FROM runs r WHERE r.session_id = s.id
   ORDER BY r.created_at, r.id LIMIT 1) AS inputText
FROM sessions s LEFT JOIN agents a ON a.id = s.agent_id
WHERE s.title IS NOT NULL ORDER BY s.id`;

const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/** Pure repair plan. Origin names deliberately do not override the first input in this one-off repair. */
export const planRetitles = (rows: readonly RetitleRow[]) => {
  const updates = rows.flatMap((row) => {
    if (row.title === null || storedTitle(row.title) !== undefined) {
      return [];
    }
    return [
      {
        id: row.id,
        newTitle: conversationTitle(row.inputText ?? "", row.agentName),
        oldTitle: row.title,
      },
    ];
  });
  // Match the old value too: leave a concurrent rename alone.
  const statements = updates.map(
    ({ id, oldTitle, newTitle }) =>
      `UPDATE sessions SET title = ${quote(newTitle)} WHERE id = ${quote(id)} AND title = ${quote(oldTitle)};`
  );
  return { statements, updates };
};
