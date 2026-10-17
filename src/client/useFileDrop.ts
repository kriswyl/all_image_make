import { useState } from "react";

/**
 * 拖「本会话里的产物」用的私有类型。
 *
 * 从资源管理器拖进来的是真文件（`Files`），可生成的图早就存在服务端了——
 * 再当文件传一遍纯属浪费。页内缩略图拖动时带上这个类型和产物 id，
 * 落点直接按 id 处理（进画布，不是上传）。
 */
export const ASSET_DRAG_TYPE = "application/x-yida-asset";

/**
 * 把任意元素变成图片落点。
 *
 * 认两种拖拽：从资源管理器拖文件进来，以及页内把**已生成的图**拖进来。
 * 拖页内其他元素或选中文本一律不处理，否则整块面板会变成落点、
 * 抢掉浏览器自己的拖拽行为。
 */
export function useFileDrop(enabled: boolean, onDrop: (files: File[], assetIds: string[]) => void) {
  const [active, setActive] = useState(false);

  function accepts(event: React.DragEvent) {
    const types = Array.from(event.dataTransfer?.types ?? []);
    return types.includes("Files") || types.includes(ASSET_DRAG_TYPE);
  }

  const dropProps = {
    onDragEnter: (event: React.DragEvent) => {
      if (!enabled || !accepts(event)) return;
      event.preventDefault();
      setActive(true);
    },
    onDragOver: (event: React.DragEvent) => {
      if (!enabled || !accepts(event)) return;
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
      if (!enabled || !accepts(event)) return;
      event.preventDefault();
      setActive(false);
      // getData 只在 drop 这一拍读得到，不能延后
      const assetIds = event.dataTransfer.getData(ASSET_DRAG_TYPE).split(",").filter(Boolean);
      onDrop(Array.from(event.dataTransfer.files), assetIds);
    },
  };

  return { active, dropProps };
}
