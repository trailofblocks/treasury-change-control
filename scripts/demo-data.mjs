import { chainReader } from "../src/chain.mjs";
import { prepare, transferTx } from "../src/treasury.mjs";

export async function seedDemo(ledger, store) {
  const chain = chainReader(ledger.config, ledger.client);
  const add = (title, to, amount, nonce) => store.create(prepare({
    title, tx: transferTx(ledger.config, ledger.token, to, amount, nonce),
  }, ledger.config), "proposer");
  const ref = row => ({ revision: row.revision, safeTxHash: row.current.safeTxHash });
  const finished = add("Infrastructure reimbursement", ledger.recipients[0], "85000000", "0");
  const approved = store.approve(finished.id, ref(finished), ledger.config.policyHash,
    await chain.snapshot(finished.current.tx), "reviewer");
  const receipt = await ledger.execute(approved.current.tx);
  const proof = await chain.execution(receipt.transactionHash, approved.current, approved.approval);
  store.executed(approved.id, ref(approved), ledger.config.policyHash, proof, "reviewer");
  add("New vendor onboarding", ledger.blocked, "200000000", "1");
  return add("November settlement", ledger.recipients[0], "125000000", "1");
}
