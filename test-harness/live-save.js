const memory = { username: "", first: "", second: "" };
const panels = new Map(Array.from(document.querySelectorAll("[data-panel]"), (panel) => [panel.dataset.panel, panel]));
const events = document.getElementById("events");

function logEvent(text) {
  if (events.children.length === 1 && events.firstElementChild.textContent === "等待操作。") events.textContent = "";
  const item = document.createElement("li");
  item.textContent = `${new Date().toLocaleTimeString()} · ${text}`;
  events.append(item);
}

function randomSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("") + "aA!9";
}

function uniqueUsername() {
  return `fapassword-save-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`;
}

function setValue(form, name, value) {
  const input = form.elements.namedItem(name);
  if (input) input.value = value;
}

function renderMemory() {
  document.getElementById("memory-user").textContent = memory.username || "尚未准备";
  document.getElementById("memory-v1").textContent = memory.first ? "已记录" : "尚未记录";
  document.getElementById("memory-v2").textContent = memory.second ? "已记录" : "尚未记录";
}

function prepare() {
  memory.username = uniqueUsername();
  memory.first = randomSecret();
  memory.second = randomSecret();
  const newForm = panels.get("new").querySelector("form");
  setValue(newForm, "username", memory.username);
  setValue(newForm, "new-password", memory.first);
  setValue(newForm, "confirm-password", memory.first);
  const loginForm = panels.get("login").querySelector("form");
  setValue(loginForm, "username", memory.username);
  setValue(loginForm, "password", memory.first);
  const changeForm = panels.get("change").querySelector("form");
  setValue(changeForm, "username", memory.username);
  setValue(changeForm, "current-password", memory.first);
  setValue(changeForm, "new-password", memory.second);
  setValue(changeForm, "confirm-password", memory.second);
  clearVerification();
  renderMemory();
  logEvent("已准备唯一用户名和两版随机密码；密码正文未写入事件记录");
}

function showMode(mode) {
  for (const [name, panel] of panels) panel.hidden = name !== mode;
  for (const button of document.querySelectorAll("[data-mode]")) {
    button.setAttribute("aria-selected", String(button.dataset.mode === mode));
  }
  panels.get(mode)?.querySelector("input")?.focus();
}

function clearVerification() {
  const form = panels.get("verify").querySelector("form");
  form.reset();
  document.getElementById("check-result").textContent = "";
}

function clearAll() {
  memory.username = memory.first = memory.second = "";
  for (const form of document.querySelectorAll("form")) form.reset();
  for (const panel of panels.values()) {
    const form = panel.querySelector("form");
    const receipt = panel.querySelector(".receipt");
    if (form) form.hidden = false;
    if (receipt) receipt.hidden = true;
  }
  renderMemory();
  document.getElementById("check-result").textContent = "";
  logEvent("已清空页面中的测试账号和密码内存");
}

function captureReference(form) {
  const data = new FormData(form);
  const kind = form.dataset.kind;
  memory.username = String(data.get("username") || "");
  if (kind === "new") memory.first = String(data.get("new-password") || "");
  if (kind === "login") memory.first = String(data.get("password") || "");
  if (kind === "change") {
    memory.first ||= String(data.get("current-password") || "");
    memory.second = String(data.get("new-password") || "");
  }
  renderMemory();
}

for (const form of document.querySelectorAll('form[data-kind]:not([data-kind="verify"])')) {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    captureReference(form);
    logEvent(`${form.dataset.kind} 场景已产生可信提交；等待 Apple 确认及独立落库核对`);
    // Keep the submitted fields visible so FAPassword can anchor its asynchronous
    // "queued / sent / failed" status beside the field after page handlers finish.
    setTimeout(() => {
      form.parentElement.querySelector(".receipt").hidden = false;
    }, 0);
  });
}

for (const button of document.querySelectorAll("[data-show-form]")) {
  button.addEventListener("click", () => {
    const panel = button.closest("[data-panel]");
    panel.querySelector("form").hidden = false;
    panel.querySelector(".receipt").hidden = true;
    panel.querySelector("input")?.focus();
  });
}

for (const button of document.querySelectorAll("[data-mode]")) {
  button.addEventListener("click", () => showMode(button.dataset.mode));
}

document.getElementById("prepare").addEventListener("click", prepare);
document.getElementById("clear-all").addEventListener("click", clearAll);
document.getElementById("clear-verify").addEventListener("click", () => {
  clearVerification();
  panels.get("verify").querySelector("input")?.focus();
  logEvent("回填字段已清空");
});
document.getElementById("check").addEventListener("click", () => {
  const form = panels.get("verify").querySelector("form");
  const username = form.elements.namedItem("username").value;
  const password = form.elements.namedItem("password").value;
  const expected = memory.second || memory.first;
  const result = document.getElementById("check-result");
  if (!memory.username || !expected) result.textContent = "没有内存基准；先准备或手工提交测试数据。";
  else if (username !== memory.username) result.textContent = "未填入本轮测试账号。";
  else if (password === expected) result.textContent = memory.second ? "回填匹配第二版密码：更新闭环成功。" : "回填匹配第一版密码：新增闭环成功。";
  else if (memory.second && password === memory.first) result.textContent = "仍回填第一版密码：新增成功，但更新尚未生效。";
  else result.textContent = "账号匹配，但密码不匹配本页保存的任一版本。";
  logEvent("已完成一次内存比较；事件记录不包含密码正文");
});

document.getElementById("origin").textContent = location.origin;
const assessment = document.getElementById("origin-assessment");
const local = ["localhost", "127.0.0.1", "::1"].includes(location.hostname) || location.hostname.endsWith(".localhost");
if (location.protocol === "https:") {
  assessment.textContent = "HTTPS 地址：可用于真实落库验收。仍须在 Passwords 中独立核对并完成回填。";
} else if (local) {
  assessment.textContent = "本地回环地址：可检查协议和确认框，但 localhost 落库失败不能代表正常 HTTPS 网站也失败。最终结论必须在 HTTPS 地址复测。";
  document.getElementById("origin-notice").classList.add("warning");
} else {
  assessment.textContent = "当前地址不是 HTTPS 或回环地址，FAPassword 会拒绝凭据操作。";
  document.getElementById("origin-notice").classList.add("warning");
}

renderMemory();
