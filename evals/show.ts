// Dev helper: print the agent's answer to questions over the fixture repo, plus what they cost.
//   npx tsx --env-file-if-exists=.env evals/show.ts "What should we review first?" "Why is #102 blocked?"
// With no arguments it runs a small typical mix and prints the measured cost per request.
import { makeRig, realLlm } from "./harness.js";

const questions = process.argv.slice(2);
const mix = questions.length
  ? questions
  : ["What should we review first, and why?", "Why is #102 blocked?", "Is #105 safe to merge?", "Summarise #104", "Which PRs are ready to merge?"];

const rig = makeRig(realLlm());
for (const q of mix) {
  const before = rig.budget.summary().spentUsd;
  const res = await rig.ask(q);
  const cost = rig.budget.summary().spentUsd - before;
  console.log(`\n=== ${q}\n${res.text}\n--- cost $${cost.toFixed(5)}`);
}
const s = rig.budget.summary();
console.log(`\nMEASURED: ${s.requests} requests, $${s.spentUsd.toFixed(5)} total, $${(s.spentUsd / s.requests).toFixed(5)} per request`);
console.log(`Projected for 2,200 requests/month at this rate: $${((s.spentUsd / s.requests) * 2200).toFixed(2)}`);
