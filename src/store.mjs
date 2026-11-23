import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { expect } from "./treasury.mjs";

const schema = `
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  current_hash TEXT NOT NULL UNIQUE,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS revisions (
  id TEXT NOT NULL REFERENCES proposals(id),
  revision INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (id, revision)
) STRICT;
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (id, revision),
  FOREIGN KEY (id, revision) REFERENCES revisions(id, revision)
) STRICT;
CREATE TABLE IF NOT EXISTS executions (
  id TEXT PRIMARY KEY REFERENCES proposals(id),
  transaction_hash TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS activity (
  sequence INTEGER PRIMARY KEY,
  id TEXT NOT NULL REFERENCES proposals(id),
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  payload TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS activity_recent ON activity(id, sequence DESC);
`;

const now = () => new Date().toISOString();
const decode = row => row ? JSON.parse(row.payload) : null;

export function openStore(path = ":memory:") {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
  db.exec(schema);

  const query = (sql, ...params) => db.prepare(sql).get(...params);
  const run = (sql, ...params) => db.prepare(sql).run(...params);
  const many = (sql, ...params) => db.prepare(sql).all(...params);

  function atomic(task, write = true) {
    db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
    try {
      const result = task();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function activity(id, action, actor, details) {
    run("INSERT INTO activity(id,action,actor,timestamp,payload) VALUES (?,?,?,?,?)",
      id, action, actor, now(), JSON.stringify(details));
  }

  function details(id, includeHistory = true) {
    const row = query("SELECT * FROM proposals WHERE id=?", id);
    expect(row, 404, "Proposal not found.");
    const current = decode(query("SELECT payload FROM revisions WHERE id=? AND revision=?", id, row.revision));
    const approval = decode(query("SELECT payload FROM approvals WHERE id=? AND revision=?", id, row.revision));
    const execution = decode(query("SELECT payload FROM executions WHERE id=?", id));
    const audit = includeHistory ? many(`
      SELECT action,actor,timestamp,payload FROM activity WHERE id=? ORDER BY sequence DESC LIMIT 40
    `, id).map(({ action, actor, timestamp, payload }) => ({ action, actor, timestamp, ...JSON.parse(payload) })) : [];
    const history = includeHistory ? many("SELECT revision,payload FROM revisions WHERE id=? ORDER BY revision DESC LIMIT 40", id)
      .map(row => ({ revision: row.revision, ...decode(row) })) : [];
    return { id, revision: row.revision, updatedAt: row.updated_at, current, approval, execution, audit, history };
  }

  function checkRef(proposal, ref) {
    expect(proposal.revision === ref.revision && proposal.current.safeTxHash === ref.safeTxHash, 409,
      "This proposal revision is stale. Reload and review the current hash.");
  }

  function checkApproval(proposal, policyHash) {
    expect(proposal.current.review.allowed && proposal.current.policyHash === policyHash, 409,
      "Current policy does not allow this proposal. Save a fresh revision before review.");
    expect(proposal.approval?.safeTxHash === proposal.current.safeTxHash && proposal.approval.policyHash === policyHash,
      409, "This revision needs a current reviewer approval.");
  }

  function assertUnique(id, hash) {
    const duplicate = query("SELECT id FROM proposals WHERE current_hash=?", hash);
    expect(!duplicate || duplicate.id === id, 409, "This Safe transaction already has a proposal.");
  }

  function create(prepared, actor) {
    return atomic(() => {
      const id = randomUUID();
      assertUnique(id, prepared.safeTxHash);
      run("INSERT INTO proposals(id,revision,current_hash,updated_at) VALUES (?,1,?,?)", id, prepared.safeTxHash, now());
      run("INSERT INTO revisions(id,revision,payload) VALUES (?,1,?)", id, JSON.stringify(prepared));
      activity(id, "created", actor, { revision: 1, safeTxHash: prepared.safeTxHash });
      return details(id);
    });
  }

  function revise(id, ref, prepared, actor) {
    return atomic(() => {
      const old = details(id, false);
      checkRef(old, ref);
      expect(!old.execution, 409, "An executed proposal is closed.");
      if (JSON.stringify(old.current) === JSON.stringify(prepared)) return details(id);
      assertUnique(id, prepared.safeTxHash);
      const revision = old.revision + 1;
      run("UPDATE proposals SET revision=?,current_hash=?,updated_at=? WHERE id=?", revision, prepared.safeTxHash, now(), id);
      run("INSERT INTO revisions(id,revision,payload) VALUES (?,?,?)", id, revision, JSON.stringify(prepared));
      activity(id, "revised", actor, { revision, safeTxHash: prepared.safeTxHash,
        previousHash: old.current.safeTxHash, supersededApproval: !!old.approval });
      return details(id);
    });
  }

  function approve(id, ref, policyHash, snapshot, actor) {
    return atomic(() => {
      const proposal = details(id, false);
      checkRef(proposal, ref);
      expect(proposal.current.review.allowed, 422, "Policy checks did not pass.");
      expect(proposal.current.policyHash === policyHash, 409, "Policy has changed. Save a fresh revision.");
      expect(!proposal.execution, 409, "An executed proposal is closed.");
      if (proposal.approval) return details(id);
      const approval = { ...ref, policyHash, actor, blockNumber: snapshot.blockNumber, timestamp: now() };
      run("INSERT INTO approvals(id,revision,payload) VALUES (?,?,?)", id, ref.revision, JSON.stringify(approval));
      run("UPDATE proposals SET updated_at=? WHERE id=?", approval.timestamp, id);
      activity(id, "approved", actor, approval);
      return details(id);
    });
  }

  function executed(id, ref, policyHash, proof, actor) {
    return atomic(() => {
      const proposal = details(id, false);
      checkRef(proposal, ref);
      checkApproval(proposal, policyHash);
      if (proposal.execution?.transactionHash === proof.transactionHash) return details(id);
      expect(!proposal.execution, 409, "An execution is already recorded for this proposal.");
      expect(!query("SELECT id FROM executions WHERE transaction_hash=?", proof.transactionHash), 409,
        "This execution receipt already belongs to another proposal.");
      const saved = { ...proof, ...ref, actor, timestamp: now() };
      run("INSERT INTO executions(id,transaction_hash,payload) VALUES (?,?,?)", id, proof.transactionHash, JSON.stringify(saved));
      run("UPDATE proposals SET updated_at=? WHERE id=?", saved.timestamp, id);
      activity(id, "executed", actor, saved);
      return details(id);
    });
  }

  return {
    create, revise, approve, executed, checkRef, checkApproval,
    details: id => atomic(() => details(id), false),
    list: () => atomic(() => many("SELECT id FROM proposals ORDER BY updated_at DESC,id LIMIT 100")
      .map(row => details(row.id, false)), false),
    close: () => db.close(),
  };
}
