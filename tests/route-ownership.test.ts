import { expect, test } from "bun:test";
import { createRouteOwnership } from "../src/ui/route-ownership.ts";

for (const covered of [false, true]) {
  const condition = covered ? "with warning" : "without warning";

  test(`list and page replies keep their source and request generation ${condition}`, async () => {
    const source = { page: "articles" };
    let content = source;
    let warning = false;
    let revision = 0;
    let value = "";
    const { canReceiveData } = createRouteOwnership({
      content: () => content,
      backPhase: () => warning ? "settling" : "idle",
      warningShown: () => warning,
    });
    const load = async (read: Promise<string>) => {
      const own = ++revision;
      const origin = content;
      const next = await read;
      if (canReceiveData(origin) && own === revision) value = next;
    };

    const first = load(Promise.resolve("first"));
    warning = covered;
    await first;
    expect(value).toBe("first");

    const outdated = load(Promise.resolve("outdated query"));
    const latest = load(Promise.resolve("latest query"));
    await Promise.all([outdated, latest]);
    expect(value).toBe("latest query");

    const departed = load(Promise.resolve("departed route"));
    content = { page: "articles" };
    await departed;
    expect(value).toBe("latest query");
  });

  test(`late push, pop and replacement follow content ownership ${condition}`, async () => {
    const source = { page: "origin" };
    const destination = { page: "destination" };
    let content = source;
    let phase = "idle";
    let warning = false;
    const events: string[] = [];
    const { commitNavigation } = createRouteOwnership({
      content: () => content,
      backPhase: () => phase,
      warningShown: () => warning,
      dismissWarning: () => { events.push("warning"); warning = false; phase = "idle"; },
    });

    for (const action of ["push", "pop", "replace"]) {
      content = source;
      const reply = Promise.resolve().then(() =>
        commitNavigation(source, () => {
          expect(warning).toBe(false);
          events.push(action);
          content = destination;
        }, action === "push"),
      );
      warning = covered;
      phase = covered ? "settling" : "idle";
      expect(await reply).toBe(true);
      expect(commitNavigation(source, () => { throw Error("departed source committed"); })).toBe(false);
    }
    expect(events).toEqual(covered ? ["warning", "push", "warning", "pop", "warning", "replace"] : ["push", "pop", "replace"]);

    warning = covered;
    expect(commitNavigation(source, () => { throw Error("stale result committed"); })).toBe(false);
    expect(warning).toBe(covered);
  });
}

test("content back motion drops pushes at reply time, including a cancelled swipe", () => {
  const source = {};
  let phase = "dragging";
  const { commitNavigation } = createRouteOwnership({
    content: () => source,
    backPhase: () => phase,
  });
  const apply = () => { throw Error("back gesture should discard the push"); };
  expect(commitNavigation(source, apply)).toBe(false);
  phase = "settling";
  expect(commitNavigation(source, apply)).toBe(false);
  phase = "idle";
  expect(commitNavigation(source, () => {})).toBe(true);
});
