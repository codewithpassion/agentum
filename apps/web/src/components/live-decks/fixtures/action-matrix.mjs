/** biome-ignore-all lint/performance/noAwaitInLoops: Each control's change is checked on the independent peer. */
import { expect } from "@playwright/test";

export async function deckActionMatrix({ alice, bob }) {
  const deck = (page, method, ...args) =>
    page.evaluate(
      ({ method: action, args: values }) =>
        Reflect.get(window, "deckRoom").deck[action](...values),
      { args, method }
    );
  const slide = () =>
    deck(bob, "read", "opening").then((result) => result.slide);
  const element = async (id) =>
    (await slide()).elements.find((item) => item.id === id);
  const button = (name) => alice.getByRole("button", { exact: true, name });
  const field = (label) => alice.getByLabel(label, { exact: true });
  const edit = async (label, value) => {
    await field(label).fill(value);
    await field(label).press("Enter");
  };
  const layers = alice.locator("details.ld-layers");
  await layers.locator("summary").click();
  const select = async (id, multiple = false) => {
    await layers
      .getByRole("button", { name: new RegExp(`: ${id}$`) })
      .click({ modifiers: multiple ? ["Shift"] : [] });
  };
  await select("box");
  for (const [key, value] of [
    ["x", "410"],
    ["y", "130"],
    ["w", "210"],
    ["h", "110"],
    ["rotate", "25"],
  ]) {
    await edit(key, value);
    await expect
      .poll(async () => (await element("box")).props[key])
      .toBe(value);
  }
  for (const [key, value] of [
    ["background-color", "#3b82f6"],
    ["border-color", "#111827"],
    ["border-width", "2px"],
  ]) {
    await edit(key, value);
    await expect
      .poll(async () => (await element("box")).style[key])
      .toBe(value);
  }
  for (const [area, value, key] of [
    ["colors", "#3b82f6", "color"],
    ["fonts", "Arial", "font-family"],
    ["sizes", "28px", "font-size"],
  ]) {
    await button(`Add ${area} token`).click();
    await expect
      .poll(async () => (await deck(bob, "theme"))[area].token_1)
      .toBe(value);
    await field(`Apply theme ${area}`).selectOption("token_1");
    await expect
      .poll(async () => (await element("box")).style[key])
      .toBe(value);
  }
  for (const [label, key] of [
    ["Apply theme fill", "background-color"],
    ["Apply theme border", "border-color"],
  ]) {
    await field(label).selectOption("token_1");
    await expect
      .poll(async () => (await element("box")).style[key])
      .toBe("#3b82f6");
  }
  for (const transition of ["none", "fade", "push", "magic"]) {
    await field("Transition").selectOption(transition);
    await expect.poll(async () => (await slide()).transition).toBe(transition);
  }
  for (const direction of ["build-in", "build-out"]) {
    for (const effect of [
      "fade",
      "rise",
      "drop",
      "left",
      "right",
      "scale",
      "pop",
    ]) {
      await field(direction).selectOption(effect);
      await expect
        .poll(async () => (await element("box")).props[direction])
        .toBe(effect);
    }
  }
  await edit("Build order", "2");
  await expect
    .poll(async () => (await element("box")).props["build-order"])
    .toBe("2");
  for (const trigger of ["click", "withPrevious", "afterPrevious"]) {
    await field("Build trigger").selectOption(trigger);
    await expect
      .poll(async () => (await element("box")).props["build-trigger"])
      .toBe(trigger);
  }
  await select("headline", true);
  for (const name of [
    "Align left",
    "Align center",
    "Align right",
    "Align top",
    "Align middle",
    "Align bottom",
  ]) {
    await button(name).click();
    await expect
      .poll(async () => JSON.stringify(await slide()))
      .toBe(JSON.stringify((await deck(alice, "read", "opening")).slide));
  }
  await button("Group").click();
  await expect
    .poll(
      async () =>
        (await slide()).elements.filter((e) => e.type === "group").length
    )
    .toBe(1);
  await button("Ungroup").click();
  await expect
    .poll(
      async () =>
        (await slide()).elements.filter((e) => e.type === "group").length
    )
    .toBe(0);
  await alice
    .getByLabel("Speaker notes", { exact: true })
    .fill("Shared presenter notes");
  await expect
    .poll(async () => (await slide()).notes)
    .toBe("Shared presenter notes");
  await button("All slides").click();
  await expect(alice.locator(".ld-grid-mode")).toBeVisible();
  await button("Slide strip").click();
  await button("Duplicate slide").click();
  await expect.poll(async () => (await deck(bob, "ids")).length).toBe(3);
  await button("Move slide 2 later").click();
  await expect
    .poll(async () => JSON.stringify(await deck(bob, "ids")))
    .toBe(await deck(alice, "ids").then(JSON.stringify));
  await button("Move slide 3 earlier").click();
  await expect
    .poll(async () => JSON.stringify(await deck(bob, "ids")))
    .toBe(await deck(alice, "ids").then(JSON.stringify));
  await button("Delete slide").click();
  await expect.poll(async () => (await deck(bob, "ids")).length).toBe(2);
  await alice.locator(".ld-thumbnail > button:first-child").first().click();
  // Local view actions don't mutate shared content; assert peer state stays equal.
  await button("Present").click();
  await button("Presenter notes").click();
  await expect(alice.locator(".ld-presentation aside")).toContainText(
    "Shared presenter notes"
  );
  await expect(alice.locator(".ld-next-slide")).toBeVisible();
  await alice.keyboard.press("End");
  await expect(alice.getByLabel("Presentation position")).toContainText(
    "Slide 2 / 2"
  );
  await alice.keyboard.press("Home");
  await expect(alice.getByLabel("Presentation position")).toContainText(
    "Slide 1 / 2"
  );
  await alice.keyboard.press("ArrowRight");
  await expect(alice.getByLabel("Presentation position")).not.toContainText(
    "build 0 /"
  );
  await alice.keyboard.press("ArrowLeft");
  await expect(alice.getByLabel("Presentation position")).toContainText(
    "build 0 /"
  );
  await alice.keyboard.press("Space");
  await expect(alice.getByLabel("Presentation position")).not.toContainText(
    "build 0 /"
  );
  await alice.keyboard.press("f");
  await expect
    .poll(() => alice.evaluate(() => !!document.fullscreenElement))
    .toBe(true);
  await alice.keyboard.press("Escape");
  await expect(alice.locator(".ld-presentation")).toHaveCount(0);
  console.log(
    "Deck mounted action matrix: geometry, theme styles, transitions, every build effect/trigger, alignment/group, notes, grid, duplicate/delete/reorder, keyboard presentation/presenter view"
  );
}
