import React, { useEffect, useRef, useState } from 'react';

// 就地重命名输入框（图标视图与列表视图共用）。
// 打开时只选中主文件名、保留扩展名，Enter 提交、Esc 取消、失焦提交。
export default function RenameInput({ value, onSubmit, onCancel }) {
  const [v, setV] = useState(value);
  const ref = useRef(null);
  useEffect(() => {
    const input = ref.current;
    input?.focus();
    const dot = value.lastIndexOf('.');
    input?.setSelectionRange(0, dot > 0 ? dot : value.length);
  }, []);
  return (
    <input
      ref={ref}
      className="rename-input"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') onSubmit(v);
        if (e.key === 'Escape') onCancel();
      }}
      onBlur={() => onSubmit(v)}
      draggable
      onDragStart={(e) => e.preventDefault()}
    />
  );
}
