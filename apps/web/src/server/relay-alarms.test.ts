import { beforeEach, describe, expect, test } from "bun:test";
import { createAlarmMux } from "./relay-alarms.ts";
import type { RelayStorage } from "./relay-core.ts";

class FakeStorage implements RelayStorage {
  alarm: number | null = null;
  values = new Map<string, unknown>();

  delete(key: string) {
    return Promise.resolve(this.values.delete(key));
  }

  deleteAlarm() {
    this.alarm = null;
    return Promise.resolve();
  }

  get<T>(key: string) {
    return Promise.resolve(this.values.get(key) as T | undefined);
  }

  getAlarm() {
    return Promise.resolve(this.alarm);
  }

  put<T>(key: string, value: T) {
    this.values.set(key, value);
    return Promise.resolve();
  }

  setAlarm(at: number) {
    this.alarm = at;
    return Promise.resolve();
  }
}

type Name = "daemon" | "computer";
const names: Name[] = ["daemon", "computer"];

let storage: FakeStorage;
let nowMs: number;

const newMux = () =>
  createAlarmMux<Name>({
    legacy: "daemon",
    names,
    now: () => nowMs,
    storage,
  });

describe("createAlarmMux", () => {
  beforeEach(() => {
    storage = new FakeStorage();
    nowMs = 0;
  });

  test("each view keeps its own alarm", async () => {
    const mux = newMux();
    await mux.view("daemon").setAlarm(100);
    await mux.view("computer").setAlarm(200);

    expect(await mux.view("daemon").getAlarm()).toBe(100);
    expect(await mux.view("computer").getAlarm()).toBe(200);
  });

  test("the real alarm is the earliest of the stored times", async () => {
    const mux = newMux();
    await mux.view("daemon").setAlarm(300);
    expect(storage.alarm).toBe(300);

    await mux.view("computer").setAlarm(200);
    expect(storage.alarm).toBe(200);
  });

  test("concurrent setAlarm calls leave the earliest time armed", async () => {
    const mux = newMux();
    await Promise.all([
      mux.view("daemon").setAlarm(100),
      mux.view("computer").setAlarm(50),
    ]);

    expect(storage.alarm).toBe(50);
  });

  test("deleting one name keeps the other and moves the real alarm to it", async () => {
    const mux = newMux();
    await mux.view("daemon").setAlarm(100);
    await mux.view("computer").setAlarm(200);

    await mux.view("daemon").deleteAlarm();

    expect(await mux.view("daemon").getAlarm()).toBeNull();
    expect(await mux.view("computer").getAlarm()).toBe(200);
    expect(storage.alarm).toBe(200);
  });

  test("deleting the last alarm clears the real alarm", async () => {
    const mux = newMux();
    await mux.view("daemon").setAlarm(100);
    await mux.view("computer").setAlarm(200);

    await mux.view("daemon").deleteAlarm();
    await mux.view("computer").deleteAlarm();

    expect(storage.alarm).toBeNull();
  });

  test("fire returns only the due names and re-arms for the future one", async () => {
    nowMs = 150;
    const mux = newMux();
    await mux.view("daemon").setAlarm(100);
    await mux.view("computer").setAlarm(300);

    expect(await mux.fire()).toEqual(["daemon"]);

    expect(await mux.view("daemon").getAlarm()).toBeNull();
    expect(await mux.view("computer").getAlarm()).toBe(300);
    expect(storage.alarm).toBe(300);
  });

  test("fire returns the due names in the order of names", async () => {
    nowMs = 500;
    const mux = newMux();
    await mux.view("computer").setAlarm(200);
    await mux.view("daemon").setAlarm(100);

    expect(await mux.fire()).toEqual(["daemon", "computer"]);
    expect(storage.alarm).toBeNull();
  });

  test("fire with nothing stored returns the legacy name", async () => {
    const mux = newMux();

    expect(await mux.fire()).toEqual(["daemon"]);
  });

  test("get, put and delete on a view reach the underlying storage", async () => {
    const mux = newMux();
    const view = mux.view("computer");

    await view.put("k", { n: 1 });
    expect(storage.values.get("k")).toEqual({ n: 1 });
    expect(await view.get<{ n: number }>("k")).toEqual({ n: 1 });

    await view.delete("k");
    expect(storage.values.has("k")).toBe(false);
    expect(await view.get("k")).toBeUndefined();
  });

  test("stored wake times survive a fresh mux on the same storage", async () => {
    nowMs = 0;
    await newMux().view("computer").setAlarm(100);

    const fresh = newMux();
    expect(await fresh.view("computer").getAlarm()).toBe(100);

    nowMs = 100;
    expect(await fresh.fire()).toEqual(["computer"]);
  });
});
