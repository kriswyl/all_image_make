import type { BoardNode, BoardViewport } from "../../shared/board";

type Rect = { x: number; y: number; width: number; height: number };

/** 显示节点与当前视口，并把小地图点击转换成画布视口。 */
export function BoardMinimap({ nodes, bounds: minimapBounds, layout: minimapLayout, viewport, size, onViewportChange }: {
  nodes: BoardNode[];
  bounds: Rect & { viewRect: Rect };
  layout: { width: number; height: number; scale: number; offsetX: number; offsetY: number };
  viewport: BoardViewport;
  size: { width: number; height: number };
  onViewportChange: (viewport: BoardViewport) => void;
}) {
  return (
        <div className="board-minimap" onPointerDown={(event) => event.stopPropagation()}>
          <svg
            width={minimapLayout.width}
            height={minimapLayout.height}
            viewBox={`0 0 ${minimapLayout.width} ${minimapLayout.height}`}
            role="img"
            aria-label="无限画布小地图"
            onPointerDown={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              const worldX = minimapBounds.x + (event.clientX - rect.left - minimapLayout.offsetX) / minimapLayout.scale;
              const worldY = minimapBounds.y + (event.clientY - rect.top - minimapLayout.offsetY) / minimapLayout.scale;
              onViewportChange({
                ...viewport,
                x: size.width / 2 - worldX * viewport.scale,
                y: size.height / 2 - worldY * viewport.scale,
              });
            }}
          >
            <rect width={minimapLayout.width} height={minimapLayout.height} className="board-minimap-bg" />
            {nodes.map((node) => (
              <rect
                key={node.id}
                className={`board-minimap-node is-${node.type}`}
                x={minimapLayout.offsetX + (node.x - minimapBounds.x) * minimapLayout.scale}
                y={minimapLayout.offsetY + (node.y - minimapBounds.y) * minimapLayout.scale}
                width={Math.max(2, node.width * minimapLayout.scale)}
                height={Math.max(2, node.height * minimapLayout.scale)}
                rx={1.5}
              />
            ))}
            <rect
              className="board-minimap-view"
              x={minimapLayout.offsetX + (minimapBounds.viewRect.x - minimapBounds.x) * minimapLayout.scale}
              y={minimapLayout.offsetY + (minimapBounds.viewRect.y - minimapBounds.y) * minimapLayout.scale}
              width={Math.max(3, minimapBounds.viewRect.width * minimapLayout.scale)}
              height={Math.max(3, minimapBounds.viewRect.height * minimapLayout.scale)}
              rx={2}
            />
          </svg>
        </div>
  );
}
