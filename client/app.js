const $ = (id) => document.getElementById(id);
let token = sessionStorage.getItem("scheduler-token");
let registration = false;
let page = 1;
let generation = 0;
let refreshing = false;
let selectedTask = null;

const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
};
const date = (value) => value ? new Date(value).toLocaleString() : "—";
const duration = (value) => value == null ? "—" : `${(Number(value)/1000).toFixed(2)} s`;
const badge = (status) => element("span", status, `badge ${status}`);
const button = (text, action) => {
    const node = element("button", text);
    node.type = "button";
    node.addEventListener("click", action);
    return node;
};
const row = (values) => {
    const tr = element("tr");
    for (const value of values) {
        const cell = element("td");
        cell.append(value instanceof Node ? value : document.createTextNode(String(value ?? "—")));
        tr.append(cell);
    }
    return tr;
};
const emptyRow = (body, count, text) => {
    const tr = element("tr");
    const td = element("td", text); td.colSpan = count; tr.append(td); body.append(tr);
};

function showSession() {
    $("auth").hidden = Boolean(token);
    $("dashboard").hidden = !token;
    $("logout").hidden = !token;
}
function logout(message = "") {
    generation++;
    token = null;
    sessionStorage.removeItem("scheduler-token");
    selectedTask = null;
    $("detail").close();
    for (const id of ["metrics","workers","tasks","logs","detail-history","detail-task"]) $(id).replaceChildren();
    $("task-form").reset();
    $("task-message").textContent = "";
    $("queue").textContent = "";
    $("status").textContent = "Loading…";
    $("auth-message").textContent = message;
    showSession();
}
async function api(path, options = {}) {
    const sentToken = token;
    const response = await fetch(path, { ...options, headers: {
        "Content-Type": "application/json", ...(sentToken ? { Authorization: `Bearer ${sentToken}` } : {}),
        ...options.headers
    } });
    const data = await response.json();
    if (!response.ok) {
        if (response.status === 401 && sentToken && token === sentToken) logout("Session expired. Please log in again.");
        throw new Error(data.message || `Request failed (${response.status})`);
    }
    return data;
}

$("switch-auth").onclick = () => {
    registration = !registration;
    $("name-field").hidden = !registration;
    $("auth-name").required = registration;
    $("password").autocomplete = registration ? "new-password" : "current-password";
    $("auth-title").textContent = $("auth-submit").textContent = registration ? "Register" : "Log in";
    $("switch-auth").textContent = registration ? "Already registered? Log in" : "Create an account";
    $("auth-message").textContent = "";
};
$("auth-form").onsubmit = async (event) => {
    event.preventDefault();
    $("auth-submit").disabled = $("switch-auth").disabled = true;
    let registered = false;
    try {
        const credentials = { email: $("email").value.trim(), password: $("password").value };
        if (registration) {
            await api("/api/auth/register", { method:"POST", body:JSON.stringify({ ...credentials, name:$("auth-name").value.trim() }) });
            registered = true;
        }
        const data = await api("/api/auth/login", { method:"POST", body:JSON.stringify(credentials) });
        token = data.token;
        sessionStorage.setItem("scheduler-token", token);
        generation++; page = 1;
        $("password").value = "";
        showSession(); await refresh();
    } catch (error) {
        $("auth-message").textContent = `${registered ? "Account created. Log in to continue. " : ""}${error.message}`;
    } finally { $("auth-submit").disabled = $("switch-auth").disabled = false; }
};
$("logout").onclick = () => logout();

function renderLogs(container, events, includeName = true) {
    container.replaceChildren();
    if (!events.length) container.append(element("p", "No recorded events yet."));
    for (const event of events) {
        const item = element("div", undefined, "log");
        item.append(element("div", `${date(event.occurred_at)} · ${includeName ? event.name + " · " : ""}Attempt ${event.attempt}`),
            element("div", `${event.message}${event.duration_ms == null ? "" : " · " + duration(event.duration_ms)}`));
        container.append(item);
    }
}
async function refresh() {
    if (!token || refreshing) return;
    refreshing = true;
    const current = generation;
    $("refresh").disabled = true;
    try {
        const data = await api(`/api/dashboard?page=${page}`);
        if (current !== generation) return;
        const m = data.metrics;
        $("metrics").replaceChildren();
        for (const [label, value] of [["Pending",m.pending],["Running",m.running],["Completed",m.completed],
            ["Failed",m.failed],["Retrying",m.retrying],["Cancelled",m.cancelled],["Retries performed",m.retries],
            ["Success rate",m.successRate == null ? "—" : `${m.successRate.toFixed(1)}%`],
            ["Failure rate",m.failureRate == null ? "—" : `${m.failureRate.toFixed(1)}%`],
            ["Average duration",duration(m.averageDurationMs)]]) {
            const card = element("div", label, "metric"); card.append(element("strong",value)); $("metrics").append(card);
        }
        $("queue").textContent = `Your queued tasks: ${m.queued}. ` + (data.queue.available
            ? `Shared Redis messages: ${data.queue.total} (${data.queue.lists.map((list) => `${list.key}: ${list.depth}`).join(", ")}).`
            : "Redis queue depth unavailable; task metrics remain available.");
        $("workers").replaceChildren();
        for (const worker of data.workers) $("workers").append(row([worker.name,badge(worker.health),worker.concurrency,worker.your_running,date(worker.last_seen_at)]));
        if (!data.workers.length) emptyRow($("workers"),5,"No workers have registered. Start a worker process.");
        $("tasks").replaceChildren();
        for (const task of data.tasks) {
            const actions = element("div");
            actions.append(button("Details", () => openTask(task.id)));
            if (["SCHEDULED","QUEUED","RETRYING","RUNNING"].includes(task.status)) {
                actions.append(button("Cancel", () => cancelTask(task.id,"TASK")));
            }
            if (task.schedule_id) actions.append(button("Stop series", () => cancelTask(task.id,"SERIES")));
            $("tasks").append(row([task.name,badge(task.cancel_requested_at && task.status === "RUNNING" ? "CANCELLING" : task.status),task.priority,date(task.scheduled_at),task.attempts,duration(task.execution_ms),actions]));
        }
        if (!data.tasks.length) emptyRow($("tasks"),7,"No tasks on this page.");
        $("page").textContent = `Page ${page} of ${Math.max(1,Math.ceil(m.total/25))}`;
        $("previous").disabled = page <= 1; $("next").disabled = page*25 >= m.total;
        renderLogs($("logs"),data.events);
        $("status").textContent = `Updated ${date(data.updatedAt)} · Refreshes every 10 seconds`;
    } catch (error) { if (current === generation) $("status").textContent = `Could not refresh: ${error.message}. Displayed data may be stale.`; }
    finally { refreshing = false; $("refresh").disabled = false; }
}
$("refresh").onclick = refresh;
$("previous").onclick = () => { if (!refreshing && page>1) { page--; refresh(); } };
$("next").onclick = () => { if (!refreshing) { page++; refresh(); } };
setInterval(() => { if (!document.hidden) refresh(); },10000);

async function openTask(id) {
    selectedTask = id;
    const current = generation;
    $("detail-task").textContent = "Loading…";
    $("detail-message").textContent = "";
    $("detail-history").replaceChildren();
    if (!$("detail").open) $("detail").showModal();
    try {
        const data = await api(`/api/dashboard/tasks/${id}`);
        if (current !== generation || selectedTask !== id) return;
        $("detail-task").textContent = JSON.stringify(data.task,null,2);
        renderLogs($("detail-history"),data.history,false);
    } catch (error) { if (current === generation) $("detail-message").textContent = error.message; }
}
$("close-detail").onclick = () => { selectedTask=null; $("detail").close(); };
$("refresh-detail").onclick = () => { if (selectedTask) openTask(selectedTask); };
async function cancelTask(id,scope) {
    if (!confirm(scope === "SERIES" ? "Stop this recurring series and cancel unfinished occurrences?" : "Cancel this task?")) return;
    const current = generation;
    try {
        await api(`/api/tasks/${id}/cancel`, { method:"POST", body:JSON.stringify({scope}) });
        if (current === generation) await refresh();
    } catch (error) { if (current === generation) $("status").textContent = error.message; }
}
$("task-type").onchange = () => { $("payload").value = $("task-type").value === "SUM" ? '{"numbers":[10,20,30]}' : '{"text":"Hello world"}'; };
$("task-form").onsubmit = async (event) => {
    event.preventDefault();
    $("create-task").disabled = true;
    const current = generation;
    try {
        // Retain this timestamp on retries so an idempotency key sees the same body.
        if (!$("scheduled").value) {
            const now = new Date();
            $("scheduled").value = new Date(now.getTime()-now.getTimezoneOffset()*60000).toISOString().slice(0,16);
        }
        const body = { name:$("task-name").value, type:$("task-type").value,
            priority:$("priority").value, payload:JSON.parse($("payload").value),
            scheduledAt:new Date($("scheduled").value).toISOString() };
        if ($("recurrence").value) body.recurrence = { intervalSeconds:Number($("recurrence").value) };
        const key = $("idempotency").value.trim();
        const result = await api("/api/tasks", { method:"POST",body:JSON.stringify(body),headers:key ? {"Idempotency-Key":key} : {} });
        if (current !== generation) return;
        $("task-message").textContent = `${result.replayed ? "Existing task" : "Created task"}: ${result.task.id}`;
        page=1; await refresh();
    } catch (error) { if (current === generation) $("task-message").textContent = error.message; }
    finally { $("create-task").disabled = false; }
};
showSession();
if (token) refresh();
