import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createRuntimeFixture, removeFixture } from "../test-fixtures/runtime.js";
import { openPointerStore } from "./pointer.js";
import { openSwitchJournal } from "./journal.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await removeFixture(root);
});
async function fixture() {
  const options = await createRuntimeFixture();
  roots.push(options.root);
  const baseline = await options.pair("baseline");
  const candidate = await options.pair("candidate");
  const pointer = await openPointerStore({ ...options, initial: baseline });
  const journal = await openSwitchJournal(options);
  const request = {
    baseline,
    copySource: baseline,
    candidate,
    switchId: randomUUID(),
    switchToken: randomUUID(),
    drainId: randomUUID(),
  };
  await journal.begin(request, await pointer.read());
  return {
    ...options,
    pointer,
    journal,
    request,
    filename: path.join(options.home, "runner/switch.json"),
  };
}
async function probing(journal: Awaited<ReturnType<typeof openSwitchJournal>>, switchId: string) {
  for (const step of [
    "preflight",
    "preflight_ok",
    "draining",
    "stopping",
    "stopped",
    "cloning",
    "cloned",
    "starting",
    "probing",
  ] as const)
    await journal.advance(switchId, step);
}

test("journal cannot claim a trial before the pointer establishes it", async () => {
  const { journal, request, pointer } = await fixture();
  await probing(journal, request.switchId);
  await expect(journal.afterPointer(request.switchId, "trial", pointer.read)).rejects.toMatchObject(
    { code: "state_conflict" },
  );
  expect((await journal.read()).transaction?.step).toBe("probing");
  await journal.afterPointer(request.switchId, "trial", () =>
    pointer.beginTrial({
      pair: request.candidate,
      switchId: request.switchId,
      candidateToken: request.switchToken,
    }),
  );
  await journal.advance(request.switchId, "committing");
  await journal.afterPointer(request.switchId, "kept", () =>
    pointer.keep({
      switchId: request.switchId,
      candidateToken: request.switchToken,
    }),
  );
  expect((await journal.read()).transaction).toMatchObject({ step: "kept", pointerSeq: 2 });
  expect((await pointer.read()).current).toEqual(request.candidate);
});

test("a failed journal write after keep leaves pointer committed and poisons this journal", async () => {
  const { journal, request, pointer, filename } = await fixture();
  await probing(journal, request.switchId);
  await journal.afterPointer(request.switchId, "trial", () =>
    pointer.beginTrial({
      pair: request.candidate,
      switchId: request.switchId,
      candidateToken: request.switchToken,
    }),
  );
  await journal.advance(request.switchId, "committing");
  const previous = await readFile(filename, "utf8");
  await expect(
    journal.afterPointer(request.switchId, "kept", async () => {
      const kept = await pointer.keep({
        switchId: request.switchId,
        candidateToken: request.switchToken,
      });
      await writeFile(filename, `${previous}\n`);
      return kept;
    }),
  ).rejects.toMatchObject({ code: "state_conflict" });
  expect((await pointer.read()).current).toEqual(request.candidate);
  await expect(journal.advance(request.switchId, "reverting")).rejects.toMatchObject({
    code: "state_conflict",
  });
  expect(JSON.parse(await readFile(filename, "utf8")).transaction.step).toBe("committing");
});

test("duplicate identity must retain its arguments and paused switches have retry and abort exits", async () => {
  const { journal, request, pointer } = await fixture();
  await journal.begin(request, await pointer.read());
  await expect(
    journal.begin({ ...request, drainId: randomUUID() }, await pointer.read()),
  ).rejects.toMatchObject({ code: "state_conflict" });
  await expect(
    journal.begin({ ...request, candidate: request.baseline }, await pointer.read()),
  ).rejects.toMatchObject({ code: "state_conflict" });
  await journal.advance(request.switchId, "preflight");
  await journal.advance(request.switchId, "preflight_ok");
  await journal.advance(request.switchId, "draining");
  await journal.advance(request.switchId, "drain_timeout");
  await expect(
    journal.begin({ ...request, switchId: randomUUID() }, await pointer.read()),
  ).rejects.toMatchObject({ code: "state_conflict" });
  await journal.advance(request.switchId, "draining");
  await journal.advance(request.switchId, "aborted");
  await journal.begin({ ...request, switchId: randomUUID() }, await pointer.read());
  expect((await journal.read()).transaction?.step).toBe("requested");
});

test("corrupt journal JSON is preserved and rejected", async () => {
  const options = await fixture();
  await options.journal.seal();
  await writeFile(options.filename, "{broken");
  await expect(openSwitchJournal(options)).rejects.toMatchObject({ code: "invalid_state" });
  expect(await readFile(options.filename, "utf8")).toBe("{broken");
  await rm(options.filename);
});

test("JavaScript callers cannot publish a pointer fact through advance", async () => {
  const { journal, request } = await fixture();
  await expect(
    Reflect.apply(journal.advance, journal, [request.switchId, "kept"]),
  ).rejects.toMatchObject({ code: "state_conflict" });
  expect((await journal.read()).transaction?.step).toBe("requested");
});

test("a future journal writer requirement rejects before invoking any pointer operation", async () => {
  const options = await fixture();
  await probing(options.journal, options.request.switchId);
  await options.journal.seal();
  const state = JSON.parse(await readFile(options.filename, "utf8"));
  await writeFile(
    options.filename,
    JSON.stringify({ ...state, schemaVersion: 2, minWriterVersion: 2 }),
  );
  const journal = await openSwitchJournal(options);
  let called = false;
  await expect(
    journal.afterPointer(options.request.switchId, "trial", async () => {
      called = true;
      return options.pointer.read();
    }),
  ).rejects.toMatchObject({ code: "unsupported_schema" });
  expect(called).toBe(false);
});
