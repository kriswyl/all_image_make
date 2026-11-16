import "./loading-indicator.css";

type LoadingVariant = "aurora" | "spectrum" | "liquid" | "dots";

const defaultSizes: Record<LoadingVariant, number> = { aurora: 136, spectrum: 152, liquid: 72, dots: 87 };

/** 装饰性动效。状态描述与实际进度由调用方提供。 */
export function LoadingIndicator({ variant, size = defaultSizes[variant] }: { variant: LoadingVariant; size?: number }) {
  return (
    <span className={`loading-indicator loading-indicator--${variant}`} style={{ fontSize: size }} aria-hidden="true">
      {variant === "aurora" ? (
        <><span /><span /><span /><span /></>
      ) : variant === "spectrum" ? (
        <span />
      ) : variant === "liquid" ? (
        <><span className="liquid-glow" /><span className="liquid-body"><span /></span></>
      ) : (
        <><span /><span /><span /><span /><span /></>
      )}
    </span>
  );
}
