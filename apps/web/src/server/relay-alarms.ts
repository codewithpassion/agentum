// One Durable Object alarm shared by several cores. Each core gets a view of
// the storage with its own alarm, and the mux arms the real alarm for the
// earliest wake time across all of them. Kept free of `cloudflare:workers`.
import type { RelayStorage } from "./relay-core.ts";

const alarmKey = (name: string) => `alarm:${name}`;

export const createAlarmMux = <Name extends string>({
  legacy,
  names,
  now,
  storage,
}: {
  names: readonly Name[];
  now: () => number;
  /** The name whose handler runs for an alarm that was armed before this mux existed (no stored wake times at all). */
  legacy: Name;
  storage: RelayStorage;
}) => {
  // Each write reads every stored time and then sets the real alarm. Running
  // them one at a time keeps a slower write from setting a stale minimum.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task);
    queue = run.catch(() => undefined);
    return run;
  };

  const readTimes = async (): Promise<Map<Name, number>> => {
    const entries = await Promise.all(
      names.map(async (name) => {
        const at = await storage.get<number>(alarmKey(name));
        return [name, at] as const;
      })
    );
    const times = new Map<Name, number>();
    for (const [name, at] of entries) {
      if (at !== undefined) {
        times.set(name, at);
      }
    }
    return times;
  };

  const rearm = async (times: Map<Name, number>) => {
    let next: number | null = null;
    for (const at of times.values()) {
      if (next === null || at < next) {
        next = at;
      }
    }
    if (next === null) {
      await storage.deleteAlarm();
    } else {
      await storage.setAlarm(next);
    }
  };

  const view = (name: Name): RelayStorage => ({
    delete: (key) => storage.delete(key),
    deleteAlarm: () =>
      serial(async () => {
        await storage.delete(alarmKey(name));
        await rearm(await readTimes());
      }),
    get: <T>(key: string) => storage.get<T>(key),
    getAlarm: async () => (await storage.get<number>(alarmKey(name))) ?? null,
    put: <T>(key: string, value: T) => storage.put(key, value),
    setAlarm: (at) =>
      serial(async () => {
        await storage.put(alarmKey(name), at);
        await rearm(await readTimes());
      }),
  });

  const fire = (): Promise<Name[]> =>
    serial(async () => {
      const times = await readTimes();
      if (times.size === 0) {
        return [legacy];
      }
      const current = now();
      const due = names.filter((name) => {
        const at = times.get(name);
        return at !== undefined && at <= current;
      });
      await Promise.all(due.map((name) => storage.delete(alarmKey(name))));
      for (const name of due) {
        times.delete(name);
      }
      await rearm(times);
      return due;
    });

  return { fire, view };
};
