import React, { useEffect, useState } from 'react';
import { useStore, notify, confirmDialog, promptDialog, fmtTime, fmtSize } from '../store.js';
import { api } from '../api.js';

export default function SharesWindow() {
  const s = useStore();
  const [shares, setShares] = useState(null);

  const load = () => api.shares().then((r) => setShares(r.shares)).catch((e) => notify({ type: 'error', title: '加载失败', body: e.message }));
  useEffect(() => { load(); }, []);

  async function create() {
    const v = await promptDialog({
      title: '创建分享',
      wide: true,
      fields: [
        { key: 'path', label: '要分享的路径（相对根目录）', required: true, placeholder: '如 home/user/report.pdf', autofocus: true },
        { key: 'expiresIn', label: '有效期', type: 'select', value: '604800', options: [
          { value: '3600', label: '1 小时' }, { value: '86400', label: '1 天' }, { value: '604800', label: '7 天' },
          { value: '2592000', label: '30 天' }, { value: '', label: '永久' },
        ] },
        { key: 'password', label: '访问密码（可选）' },
        { key: 'allowDownload', label: '允许下载', type: 'checkbox', value: true },
        { key: 'allowUpload', label: '允许他人上传到此目录', type: 'checkbox' },
        { key: 'maxDownloads', label: '下载次数上限（可选）', type: 'number' },
      ],
      okText: '创建',
    });
    if (!v) return;
    try {
      const r = await api.shareCreate({
        path: String(v.path).replace(/^\/+|\/+$/g, ''),
        expiresIn: v.expiresIn || null,
        password: v.password || null,
        allowDownload: !!v.allowDownload,
        allowUpload: !!v.allowUpload,
        maxDownloads: v.maxDownloads || null,
      });
      const url = `${location.origin}/s/${r.share.token}`;
      navigator.clipboard?.writeText(url).catch(() => {});
      notify({ type: 'success', title: '分享已创建，链接已复制', body: url });
      load();
    } catch (e) { notify({ type: 'error', title: '创建失败', body: e.message }); }
  }

  async function cancelShare(share) {
    if (!await confirmDialog({ title: '取消分享', message: `取消后链接立即失效：/${share.name}` })) return;
    await api.shareUpdate(share.id, { action: 'cancel' });
    load();
  }
  async function removeShare(share) {
    if (!await confirmDialog({ title: '删除记录', message: '仅删除分享记录，不影响文件。', danger: true, okText: '删除' })) return;
    await api.shareDelete(share.id);
    load();
  }
  async function cleanup() {
    const r = await api.sharesCleanup();
    notify({ type: 'info', title: `已清理 ${r.removed} 条失效分享` });
    load();
  }

  const status = (sh) => (sh.canceled ? '已取消' : sh.expiresAt && sh.expiresAt < Date.now() ? '已过期' : sh.maxDownloads && sh.downloads >= sh.maxDownloads ? '已达上限' : '有效');

  return (
    <div className="shares-window">
      <div className="section-head">
        <h4>分享管理</h4>
        <div className="section-actions">
          <button className="btn btn-small" onClick={cleanup}>清理失效</button>
          <button className="btn btn-small btn-primary" onClick={create}>新建分享…</button>
        </div>
      </div>
      {!shares ? <div className="boot-spinner" /> : shares.length === 0 ? (
        <div className="empty-hint">还没有创建过分享。在桌面或文件窗口中右键任意文件或文件夹，选择“分享…”。</div>
      ) : (
        <div className="shares-table-wrap">
          <table className="list-table">
            <thead><tr><th>名称</th><th>状态</th><th>访问/下载</th><th>有效期至</th><th>操作</th></tr></thead>
            <tbody>
              {shares.map((sh) => (
                <tr key={sh.id}>
                  <td className="ellipsis" title={`/${sh.path}`}>{sh.isDir ? '📁' : '📄'} {sh.name}</td>
                  <td><span className={`share-status st-${status(sh) === '有效' ? 'ok' : 'bad'}`}>{status(sh)}</span></td>
                  <td>{sh.downloads}{sh.maxDownloads ? ` / ${sh.maxDownloads}` : ''} 次</td>
                  <td>{sh.expiresAt ? fmtTime(sh.expiresAt) : '永久'}</td>
                  <td className="row-actions">
                    <button className="btn btn-small" onClick={() => {
                      const url = `${location.origin}/s/${sh.token}`;
                      navigator.clipboard?.writeText(url).then(() => notify({ title: '链接已复制', body: url })).catch(() => notify({ title: url, body: '请手动复制' }));
                    }}>复制链接</button>
                    <button className="btn btn-small" onClick={() => window.open(`/s/${sh.token}`, '_blank')}>打开</button>
                    <button className="btn btn-small" onClick={() => cancelShare(sh)}>取消</button>
                    <button className="btn btn-small" onClick={() => removeShare(sh)}>删除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
