const $ = id => document.getElementById(id);
const state = { token: "", config: null, demo: false, selected: null, proposals: [], proposal: null, safe: null, view: "review", session: 0, query: 0 };
const statuses = {
  in_review: "In review", approved: "Approved", blocked: "Policy blocked", executed: "Executed",
  stale_policy: "Policy changed", stale_nonce: "Nonce unavailable",
};
const labels = {
  created: "Proposal created", revised: "Proposal revised", approved: "Revision approved", executed: "Execution verified",
};
const timing = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

function node(tag, text = "", className = "") {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

function control(text, action, style = "secondary") {
  const button = node("button", text, style);
  button.type = "button";
  button.addEventListener("click", () => action(button));
  return button;
}

function message(id, text = "") {
  $(id).textContent = text;
  $(id).hidden = !text;
}

function shorten(txHash) {
  return `${txHash.slice(0, 10)}…${txHash.slice(-6)}`;
}

function showTab(name) {
  state.view = name;
  for (const button of document.querySelectorAll("[data-panel]")) {
    const active = button.dataset.panel === name;
    $(`panel-${button.dataset.panel}`).hidden = !active;
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
}

function badge(status) {
  const chip = node("span", statuses[status], "badge");
  chip.dataset.status = status;
  return chip;
}

async function api(path, { method = "GET", body, token = state.token, download = false } = {}) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(path, { method, headers, cache: "no-store",
    body: body === undefined ? undefined : JSON.stringify(body) });
  if (response.ok && download) return response.blob();
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "The request failed.");
  return result;
}

function path(proposal = state.proposal) {
  return `/api/proposals/${proposal.id}`;
}

function ref(proposal = state.proposal) {
  return { revision: proposal.revision, safeTxHash: proposal.current.safeTxHash };
}

function showQueue() {
  const filter = $("filter").value;
  const rows = state.proposals.filter(item => filter === "all" || item.status === filter);
  $("none").hidden = rows.length > 0;
  $("queue").replaceChildren(...rows.map(item => {
    const row = node("li");
    const button = control("", () => select(item.id), "queue-item");
    if (item.id === state.selected) button.setAttribute("aria-current", "true");
    button.append(node("strong", item.title), node("span", item.transfer?.display || "Unsupported call", "queue-amount"),
      badge(item.status));
    row.append(button);
    return row;
  }));
}

async function loadQueue(epoch) {
  const result = await api("/api/proposals");
  if (epoch !== state.session) return false;
  state.proposals = result.proposals;
  showQueue();
  return true;
}

async function loadSafe(epoch) {
  $("health").textContent = "Checking";
  let snapshot = null;
  try { snapshot = await api("/api/safe"); } catch {}
  if (epoch !== state.session) return;
  state.safe = snapshot;
  $("safe-nonce").textContent = snapshot?.nonce ?? "—";
  $("safe-threshold").textContent = snapshot ? `${snapshot.threshold} of ${snapshot.owners.length}` : "—";
  $("health").textContent = snapshot ? "Connected" : "Unavailable";
  $("health").dataset.health = snapshot ? "good" : "offline";
  if (state.proposal) render(state.proposal);
}

async function select(id, keepTab = false) {
  const epoch = state.session;
  const run = ++state.query;
  state.selected = id;
  state.proposal = null;
  $("detail").hidden = true;
  $("empty").hidden = false;
  message("error");
  if (!keepTab) message("notice");
  showQueue();
  try {
    const proposal = await api(`/api/proposals/${id}`);
    if (epoch !== state.session || run !== state.query) return;
    state.proposal = proposal;
    render(proposal);
    if (!keepTab) showTab("review");
  } catch (error) {
    if (epoch === state.session && run === state.query) message("error", error.message);
  }
}

function fact(label, value, copy = false) {
  const item = node("div");
  const description = node("dd", value, copy ? "mono" : "");
  if (copy) {
    description.title = value;
    const button = control("Copy", async () => {
      try { await navigator.clipboard.writeText(value); message("notice", `${label} copied.`); }
      catch { message("error", "Could not access the clipboard."); }
    }, "subtle");
    item.append(node("dt", label), description, button);
  } else item.append(node("dt", label), description);
  return item;
}

function drawAudit(proposal) {
  $("audit").replaceChildren(...proposal.audit.map(event => {
    const item = node("li");
    item.append(node("strong", labels[event.action] || event.action),
      node("span", `Revision ${event.revision} · ${event.actor} · ${timing.format(new Date(event.timestamp))}`),
      node("code", event.safeTxHash));
    if (event.supersededApproval) item.append(node("span", "Superseded the previous approval.", "warning-text"));
    return item;
  }));
  $("history").replaceChildren(...proposal.history.map(revision => {
    const item = node("li");
    item.append(node("strong", `Revision ${revision.revision} · ${revision.title}`),
      node("span", revision.review.transfer?.display || "Unsupported call"), node("code", revision.safeTxHash));
    return item;
  }));
}

function drawExecution(execution) {
  const panel = $("execution-card");
  panel.hidden = !execution;
  panel.replaceChildren();
  if (!execution) return;
  const unit = execution.confirmations === "1" ? "confirmation" : "confirmations";
  panel.append(node("h3", "On-chain execution"), node("p", `Verified in block ${execution.blockNumber} · ${execution.confirmations} ${unit}`));
  if (state.config.chainId === 11155111) {
    const link = node("a", "View Sepolia transaction");
    link.href = `https://sepolia.etherscan.io/tx/${execution.transactionHash}`;
    link.rel = "noreferrer";
    link.target = "_blank";
    panel.append(link);
  }
  panel.append(node("code", execution.transactionHash));
}

function render(proposal) {
  const { current, status, revision } = proposal;
  const stale = Boolean(state.safe && current.tx.nonce !== state.safe.nonce && ["in_review", "approved"].includes(status));
  const visualStatus = stale ? "stale_nonce" : status;
  $("empty").hidden = true;
  $("detail").hidden = false;
  $("proposal-title").textContent = current.title;
  $("revision").textContent = `Revision ${revision}`;
  $("status").textContent = statuses[visualStatus];
  $("status").dataset.status = visualStatus;
  $("transfer-amount").textContent = current.review.transfer?.display || "Unsupported call";
  $("facts").replaceChildren(
    fact("Token contract", current.tx.to, true),
    fact("Recipient", current.review.transfer?.recipient || "Unavailable", Boolean(current.review.transfer)),
    fact("Safe transaction hash", current.safeTxHash, true),
    fact("Proposal nonce", current.tx.nonce),
  );
  const help = {
    blocked: "One or more checks failed. A proposer can revise this request.",
    in_review: "A reviewer can approve this revision after checking the transfer.",
    approved: "Internal approval is recorded for this exact hash. Safe owners sign in Safe.",
    stale_policy: "The workspace policy changed. Save a new revision for review.",
    stale_nonce: "The proposal nonce differs from the Safe’s current nonce. The signing export is unavailable.",
    executed: "The Safe execution and the exact ERC-20 transfer were verified.",
  };
  $("review-description").textContent = help[visualStatus];
  $("checks").replaceChildren(...current.review.checks.map(check => {
    const item = node("li");
    item.append(node("span", check.label), node("strong", check.pass ? "Pass" : "Blocked", check.pass ? "pass" : "fail"));
    return item;
  }));
  $("payload").textContent = JSON.stringify({ ...current.tx, safeTxHash: current.safeTxHash }, null, 2);
  drawAudit(proposal);
  drawExecution(proposal.execution);
  const actions = [];
  if (status !== "executed" && state.config.actor === "proposer") {
    actions.push(control("Revise proposal", () => edit(proposal)));
  }
  if (visualStatus === "in_review" && state.config.actor === "reviewer") {
    const action = control("Approve revision", button => update(button,
      () => api(path(proposal) + "/approve", { method: "POST", body: ref(proposal) }), "Revision approved."), "primary");
    action.disabled = !state.safe;
    actions.push(action);
  }
  if (visualStatus === "approved") {
    const action = control("Download signing packet", button => download(proposal, button), "primary");
    action.disabled = !state.safe;
    actions.push(action);
  }
  if (status === "approved" && state.config.actor === "reviewer") {
    actions.push(control("Verify execution", () => {
      $("receipt-form").reset();
      message("receipt-error");
      $("receipt-dialog").showModal();
    }));
  }
  $("proposal-actions").replaceChildren(...actions);
  $("proposal-actions").hidden = actions.length === 0;
}

async function update(button, task, success, errorTarget = "error") {
  const epoch = state.session;
  button.disabled = true;
  message(errorTarget);
  try {
    const proposal = await task();
    if (epoch !== state.session) return;
    document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close());
    if (!await loadQueue(epoch)) return;
    await select(proposal.id, true);
    if (epoch !== state.session) return;
    await loadSafe(epoch);
    if (epoch === state.session) message("notice", success);
  } catch (error) {
    if (epoch === state.session) {
      const open = $(errorTarget).closest("dialog");
      message(open && !open.open ? "error" : errorTarget, error.message);
    }
  } finally {
    button.disabled = false;
  }
}

async function download(proposal, button) {
  const epoch = state.session;
  button.disabled = true;
  message("error");
  try {
    const blob = await api(path(proposal) + "/export", { method: "POST", body: ref(proposal), download: true });
    if (epoch !== state.session) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `treasury-${proposal.id}-r${proposal.revision}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  } catch (error) {
    if (epoch === state.session) message("error", error.message);
  } finally {
    button.disabled = false;
  }
}

let editing = null;
function mode() {
  const raw = $("input-type").value === "raw";
  $("transfer-fields").hidden = raw;
  $("transfer-fields").disabled = raw;
  $("raw-wrap").hidden = !raw;
  $("editor").elements.raw.required = raw;
}

function tokenHint() {
  const token = state.config.tokens.find(t => t.address === $("editor").elements.token.value);
  $("transfer-help").textContent = token ? `${token.symbol} uses ${token.decimals} decimals. Limit ${token.limit} base units.` : "";
}

function edit(proposal = null) {
  editing = proposal;
  const form = $("editor");
  form.reset();
  message("editor-error");
  $("editor-title").textContent = proposal ? "Revise proposal" : "New proposal";
  form.elements.token.replaceChildren(...state.config.tokens.map(token => {
    const choice = node("option", token.symbol);
    choice.value = token.address;
    return choice;
  }));
  form.elements.nonce.value = state.safe?.nonce || "";
  if (proposal) {
    form.elements.title.value = proposal.current.title;
    const transfer = proposal.current.review.transfer;
    const known = state.config.tokens.some(token => token.address === transfer?.token);
    if (transfer && known && proposal.current.review.checks[0].pass && proposal.current.review.checks[1].pass) {
      form.elements.token.value = transfer.token;
      form.elements.recipient.value = transfer.recipient;
      form.elements.amount.value = transfer.amount;
      form.elements.nonce.value = proposal.current.tx.nonce;
    } else {
      $("input-type").value = "raw";
    }
    form.elements.raw.value = JSON.stringify(proposal.current.tx, null, 2);
  }
  mode();
  tokenHint();
  $("proposal-dialog").showModal();
}

function clear() {
  state.session++;
  state.query++;
  state.token = "";
  state.config = null;
  state.proposal = null;
  state.proposals = [];
  state.safe = null;
  $("workspace").hidden = true;
  $("session").hidden = true;
  $("detail").hidden = true;
  $("empty").hidden = false;
  $("queue").replaceChildren();
  $("payload").textContent = "";
  document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close());
  return state.session;
}

async function login(token, epoch) {
  const config = await api("/api/me", { token });
  if (epoch !== state.session) return;
  state.token = token;
  state.config = config;
  $("signin").hidden = true;
  $("workspace").hidden = false;
  $("session").hidden = false;
  $("role-control").hidden = !state.demo;
  $("role-name").hidden = state.demo;
  $("role-name").textContent = config.actor === "reviewer" ? "Reviewer" : "Proposer";
  $("logout").hidden = state.demo;
  $("add").hidden = config.actor !== "proposer";
  $("network").textContent = config.chainId === 11155111 ? "Sepolia" : "Local test chain";
  $("safe-address").textContent = config.safe;
  $("policy-hash").textContent = shorten(config.policyHash);
  $("policy-hash").title = config.policyHash;
  message("notice");
  message("error");
  const [loaded] = await Promise.all([loadQueue(epoch), loadSafe(epoch)]);
  if (loaded && epoch === state.session && state.proposals.length) {
    const selected = state.proposals.find(item => item.id === state.selected) ||
      state.proposals.find(item => item.status === "in_review") || state.proposals[0];
    await select(selected.id);
  }
}

async function demoLogin() {
  const epoch = clear();
  try {
    const role = $("role").value;
    const { token } = await api("/api/demo/session", { method: "POST", body: { role }, token: "" });
    await login(token, epoch);
  } catch (error) {
    if (epoch === state.session) {
      $("signin").hidden = false;
      message("signin-error", error.message);
    }
  }
}

$("add").addEventListener("click", () => edit());
$("input-type").addEventListener("change", mode);
$("editor").elements.token.addEventListener("change", tokenHint);
$("filter").addEventListener("change", showQueue);
$("role").addEventListener("change", demoLogin);
$("logout").addEventListener("click", () => { clear(); $("signin").hidden = false; });
for (const button of document.querySelectorAll("[data-panel]")) button.addEventListener("click", () => showTab(button.dataset.panel));
for (const button of document.querySelectorAll("[data-close]")) button.addEventListener("click", () => $(button.dataset.close).close());

$("signin-form").addEventListener("submit", async event => {
  event.preventDefault();
  message("signin-error");
  const epoch = clear();
  try {
    await login($("workspace-token").value.trim(), epoch);
    $("workspace-token").value = "";
  } catch (error) {
    if (epoch === state.session) message("signin-error", error.message);
  }
});

$("editor").addEventListener("submit", event => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget));
  const previous = editing;
  const body = { title: values.title };
  if (previous) body.current = ref(previous);
  if (values.mode === "raw") {
    try { body.tx = JSON.parse(values.raw); }
    catch { message("editor-error", "Enter a valid Safe transaction JSON object."); return; }
  } else {
    body.transfer = { token: values.token, recipient: values.recipient, amount: values.amount, nonce: values.nonce };
  }
  update(event.submitter, () => api(previous ? path(previous) : "/api/proposals", {
    method: previous ? "PUT" : "POST", body,
  }), previous ? "Proposal revision saved." : "Proposal created.", "editor-error");
});

$("receipt-form").addEventListener("submit", event => {
  event.preventDefault();
  const proposal = state.proposal;
  const transactionHash = event.currentTarget.elements.transactionHash.value.trim();
  update(event.submitter, () => api(path(proposal) + "/execution", {
    method: "POST", body: { ...ref(proposal), transactionHash },
  }), "Execution receipt verified.", "receipt-error");
});

$("refresh").addEventListener("click", async () => {
  const epoch = state.session;
  try {
    const [loaded] = await Promise.all([loadQueue(epoch), loadSafe(epoch)]);
    if (loaded && epoch === state.session && state.selected) await select(state.selected, true);
  } catch (error) {
    if (epoch === state.session) message("error", error.message);
  }
});

try {
  state.demo = (await api("/api/config")).demo;
  if (state.demo) await demoLogin();
  else $("signin").hidden = false;
} catch (error) {
  $("signin").hidden = false;
  message("signin-error", error.message);
}
