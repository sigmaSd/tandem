// Tandems of their own for the tests: each with its files in a scratch folder, listening only on this
// computer, silent on the network. A test file calls afterEach(stopAll).

import { put, scratch } from "./_env.ts";
import { Core, type Job } from "../src/core.ts";

export const running: Core[] = [];

/** Stop every Tandem a test started (its database closed, so its folders can be deleted on Windows). */
export async function stopAll() {
  await Promise.all(running.splice(0).map((c) => c.stop()));
}

/** A Tandem with one folder (its id: `fid`), holding `files`. */
export async function tandem(
  name: string,
  files: Record<string, string> = {},
  opts: { watch?: boolean } = {},
) {
  const core = new Core(scratch(`${name}-state`), { discovery: false, bind: "127.0.0.1", port: 0, ...opts });
  await core.init();
  core.config.device.name = name;
  const folder = scratch(`${name}-folder`);
  put(folder, files);
  const fid = await core.addFolder(folder);
  running.push(core);
  return { core, folder, fid };
}

/** The copies of a Tandem's folder (its first one by default). */
export function copies(core: Core, fid = core.config.folders[0].id) {
  return core.config.folders.find((f) => f.id === fid)!.copies;
}

/** Wait for the sync to reach a phase. */
export function reach<P extends Job["phase"]>(
  core: Core,
  ...phases: P[]
): Promise<Extract<Job, { phase: P }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`still ${core.job?.phase}`)), 15_000);
    const check = () => {
      const job = core.job;
      if (job?.phase === "error" && !phases.includes("error" as P)) {
        clearTimeout(timer);
        off();
        return reject(new Error(job.message));
      }
      if (!job || !phases.includes(job.phase as P)) return;
      clearTimeout(timer);
      off();
      resolve(job as Extract<Job, { phase: P }>);
    };
    const off = core.onChange(check);
    check();
  });
}

/**
 * Pair two Tandems with a code, each from its "add a copy" screen of a folder (their first ones by default,
 * "" for none): the two folders are linked at once. Returns the copy of each on the other.
 */
export async function pair(a: Core, b: Core, fa = a.config.folders[0]?.id, fb = b.config.folders[0]?.id) {
  const code = await a.startPairing(fa || undefined);
  await b.pair(`127.0.0.1:${a.port}`, code, fb || undefined);
  const last = (core: Core, fid?: string) => (fid ? copies(core, fid).at(-1) : undefined);
  // offered both ways at once: the side that showed the code may link a moment after the other
  for (let i = 0; fa && fb && last(a, fa)?.remote === null; i++) {
    if (i > 100) throw new Error("the two folders were not linked");
    await new Promise((r) => setTimeout(r, 20));
  }
  return { onA: last(a, fa)?.id ?? "", onB: last(b, fb)?.id ?? "" };
}

/** Compare, answer nothing, apply. */
export async function syncNow(core: Core, copyId: string) {
  core.compare(copyId);
  const job = await reach(core, "review", "done");
  if (job.phase === "review") core.start();
  return (await reach(core, "done")).summary;
}
