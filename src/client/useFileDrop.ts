import { useState } from "react";

/**
 * 把任意元素变成图片落点。
 *
 * 只接管「从资源管理器拖文件进来」这一种拖拽：拖的是页内元素或选中文本时
 * 一律不处理，否则整块面板会变成落点，抢掉浏览器自己的拖拽行为。
 */
export function useFileDrop(enabled: boolean, onDrop: (files: File[]) => void) {
  const [active, setActive] = useState(false);

  function dragsFiles(event: React.DragEvent) {
    return Array.from(event.dataTransfer?.types ?? []).includes("Files");
  }

  const dropProps = {
    onDragEnter: (event: React.DragEvent) => {
      if (!enabled || !dragsFiles(event)) return;
      event.preventDefault();
      setActive(true);
    },
    onDragOver: (event: React.DragEvent) => {
      if (!enabled || !dragsFiles(event)) return;
      // 不 preventDefault 浏览器会直接把文件当页面打开
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (event: React.DragEvent) => {
      // 移到子元素上也会触发 dragleave，只有真的离开整块区域才复位
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      setActive(false);
    },
    onDrop: (event: React.DragEvent) => {
      if (!enabled || !dragsFiles(event)) return;
      event.preventDefault();
      setActive(false);
      onDrop(Array.from(event.dataTransfer.files));
    },
  };

  return { active, dropProps };
}
