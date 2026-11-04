// A second Iterbar process for the store tests. It runs the built store (dist/store.js) and speaks JSON lines:
// it prints {"event":"ready"} once loaded, waits for "go" on stdin, opens the store and prints
// {"event":"acquired"} or {"event":"error","code":...}. Modes:
//   hold                    keep the store open until stdin closes, then close it
//   crash-after-attachments create feedback with both attachments and stop for good once they are on disk,
//                           after printing {"event":"attachments-written","feedbackId":...}; the test kills it
import { createInterface } from "node:readline";
import { openFeedbackStore } from "../../../dist/store.js";

const [mode, projectRoot, draftJson] = process.argv.slice(2);
const print = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const nextLine = async () => (await lines.next()).value;

print({ event: "ready", pid: process.pid });
await nextLine();

let store;
try {
  store = await openFeedbackStore(projectRoot, {
    afterAttachmentsWritten: mode === "crash-after-attachments"
      ? async (feedbackId) => {
        print({ event: "attachments-written", feedbackId });
        await new Promise(() => setInterval(() => {}, 60_000));
      }
      : undefined,
  });
} catch (error) {
  print({ event: "error", code: error.code ?? null, ownerPid: error.owner?.pid ?? null, message: error.message });
  process.exit(0);
}
print({ event: "acquired", pid: process.pid });

if (mode === "crash-after-attachments") {
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  await store.create(JSON.parse(draftJson), { screenshot: png, evidence: Buffer.from('{"events":[]}') });
} else {
  while ((await nextLine()) !== undefined);
  await store.close();
  print({ event: "closed" });
}
