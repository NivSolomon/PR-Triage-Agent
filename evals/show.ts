// Dev helper: print the agent's answer to one question over the fixture repo.
//   npx tsx --env-file-if-exists=.env evals/show.ts "What should we review first?"
import { makeRig, realLlm } from "./harness.js";

const question = process.argv.slice(2).join(" ") || "What should we review first, and why?";
const rig = makeRig(realLlm());
const res = await rig.ask(question);
console.log(res.text);
console.log("\n--- tool activity:", JSON.stringify({ list: rig.github.calls.listOpenPrs, getPr: rig.github.calls.getPr }));
