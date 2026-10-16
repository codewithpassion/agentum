/**
 * Client ids of every app whose name matches another app's, ignoring case.
 * Anyone can register an app under any name, so a second "Claude" is a
 * warning sign. Names are cleaned when stored (hidden characters and extra
 * whitespace gone). Apps without a name are never flagged: they carry no name
 * to impersonate with.
 */
export const duplicateNameClientIds = (
  clients: readonly { clientId: string; name: string | null }[]
): Set<string> => {
  const byName = new Map<string, string[]>();
  for (const client of clients) {
    const name = client.name?.toLowerCase();
    if (name) {
      byName.set(name, [...(byName.get(name) ?? []), client.clientId]);
    }
  }
  const duplicates = new Set<string>();
  for (const ids of byName.values()) {
    if (ids.length > 1) {
      for (const id of ids) {
        duplicates.add(id);
      }
    }
  }
  return duplicates;
};
