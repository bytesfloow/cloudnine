import { api } from '../api.js';
import { setState } from '../store.js';
import { loadBootData } from '../App.jsx';

// 初始化 / 登录成功后的入口
export async function loadBootDataState() {
  const st = await api.state();
  setState({ initialized: st.initialized, user: st.user, siteName: st.siteName, version: st.version });
  document.title = st.siteName;
  loadBootData();
}
