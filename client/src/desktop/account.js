import { api } from '../api.js';
import { showDialog, notify, confirmDialog, setState } from '../store.js';

// 账户动作：任务栏托盘与（阶段 1 · T4 的）开始菜单底部账户区共用。
// 从顶栏账户菜单原样迁出：删掉顶栏右侧账户区时，「修改密码」不能再跟着消失（docs §7 R2）。

export async function changePasswordFlow() {
  const values = await showDialog({
    kind: 'form',
    title: '修改密码',
    fields: [
      { key: 'current', label: '原密码', type: 'password', required: true },
      { key: 'next', label: '新密码（≥8 位，含字母数字）', type: 'password', required: true },
    ],
    okText: '修改',
  });
  if (!values) return;
  try {
    await api.changePassword(values);
    notify({ type: 'success', title: '密码已修改' });
  } catch (e) {
    notify({ type: 'error', title: '修改失败', body: e.message });
  }
}

// 退出登录与锁定共用一段收尾：注销会话、清空窗口、回到登录页
async function signOut() {
  await api.logout().catch(() => {});
  setState({ user: null, windows: [], focusId: null });
}

export async function logoutFlow() {
  if (!(await confirmDialog({ title: '退出登录', message: '确定要退出当前会话吗？' }))) return;
  await signOut();
}

// 开始菜单电源位：「锁定」= 回到登录页（docs §1.3 底部账户区）
export async function lockFlow() {
  if (!(await confirmDialog({
    title: '锁定',
    message: '锁定后回到登录页，需要重新输入密码。',
    okText: '锁定',
  }))) return;
  await signOut();
}
