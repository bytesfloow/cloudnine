import { api } from '../api.js';
import { showDialog, notify, confirmDialog, setState } from '../store.js';

// 账户动作：任务栏托盘与（阶段 1 · T4 的）开始菜单底部账户区共用。
// 从 MenuBar.jsx 原样迁出：删掉顶栏右侧账户菜单时，「修改密码」不能再跟着消失（docs §7 R2）。

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

export async function logoutFlow() {
  if (!(await confirmDialog({ title: '退出登录', message: '确定要退出当前会话吗？' }))) return;
  await api.logout().catch(() => {});
  setState({ user: null, windows: [], focusId: null });
}
