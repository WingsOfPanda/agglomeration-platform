import { ArgsFileError, KvError } from "../args.js";
import { SlugError } from "./slug.js";

export type Handler = (args: string[]) => Promise<number>;

/** Run a subcommand handler, converting a KvError (a missing flag value), a SlugError (an
 *  out-of-charset topic/agent refused at the path gate), or an ArgsFileError (a misplaced
 *  `--args-file`) into a clean rc-2 message on stderr. Any other error propagates to the
 *  top-level crash handler (rc 1 + stack). */
export async function dispatch(fn: Handler, args: string[]): Promise<number> {
  try {
    return await fn(args);
  } catch (e) {
    if (e instanceof KvError || e instanceof SlugError || e instanceof ArgsFileError) {
      process.stderr.write(`${e.message}\n`);
      return e.code;
    }
    throw e;
  }
}
