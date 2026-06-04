import { describe, it, expect } from "vitest";
import { dispatch } from "../src/core/dispatch.js";
import { KvError } from "../src/args.js";

describe("dispatch", () => {
  it("returns the handler's exit code on success", async () => {
    expect(await dispatch(async () => 0, [])).toBe(0);
    expect(await dispatch(async () => 3, [])).toBe(3);
  });

  it("converts a KvError into rc 2 with the message on stderr", async () => {
    const errs: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: string) => { errs.push(String(s)); return true; };
    let rc = -1;
    try { rc = await dispatch(async () => { throw new KvError("--metric"); }, []); }
    finally { (process.stderr as any).write = orig; }
    expect(rc).toBe(2);
    expect(errs.join("")).toContain("--metric requires a value");
  });

  it("re-throws a non-KvError (so it still hits the top-level rc-1 crash handler)", async () => {
    await expect(dispatch(async () => { throw new Error("boom"); }, [])).rejects.toThrow("boom");
  });
});
