const username = `fapassword-save-test-${new Date().toISOString().replace(/\D/g, '').slice(0,14)}`;
const makeSecret = () => Array.from(crypto.getRandomValues(new Uint8Array(18)), n => n.toString(16).padStart(2,'0')).join('') + 'aA!9';
const initial = makeSecret(), updated = makeSecret();
const user = document.getElementById('username'), password = document.getElementById('password');
const result = document.getElementById('result');
let version = 1;
document.getElementById('account').textContent = username;
const prepare = next => {
  version = next; user.value = username; password.value = next === 1 ? initial : updated;
  result.textContent = `已准备第 ${next} 版虚构密码；点击登录提交。`;
};
document.getElementById('new').onclick = () => prepare(1);
document.getElementById('update').onclick = () => prepare(2);
document.getElementById('clear').onclick = () => { user.value = ''; password.value = ''; result.textContent = '等待扩展填充本测试账号。'; };
document.getElementById('check').onclick = () => {
  result.textContent = user.value !== username ? '未填入本测试账号。' : password.value === updated ? '回填匹配第 2 版密码。' : password.value === initial ? '回填匹配第 1 版密码。' : '回填未匹配本次测试密码。';
};
document.getElementById('login').addEventListener('submit', event => {
  event.preventDefault();
  result.textContent = `本页已收到第 ${version} 版提交；请查看 Apple 是否显示保存／更新确认。尚未验证实际保存。`;
});
