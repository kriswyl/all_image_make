/**
 * 输入框。
 *
 * 回车发送、Shift+回车换行——对话式界面里最省的交互，用户不用挪手去点按钮。
 * 正在跑的时候按钮变成「停止」：一堂生图要几十秒，没有中断入口用户只能干等。
 *
 * 自己带的图也在这里进（需求.md 问题 4）：点左边的图片按钮挑文件，
 * 或者直接把图拖进来。两种入口都通向同一条上传路径——上传后它就是一个**一等素材**，
 * 能当画布、能当参考图，不是发完就丢的附件。
 */
import { CornerDownLeft, ImagePlus, LoaderCircle, Send, Square, Sparkles } from "lucide-react";
import { useRef, useState } from "react";
import { useFileDrop } from "../useFileDrop";

/** 空会话时的引导。写的是这个能力**真正**能做的事，不是泛泛的「试试看」 */
const STARTERS = [
  "画一只戴草帽的橘猫，水彩风",
  "把这张图的手改成握着咖啡杯",
  "把刚才那张变成 5 秒的视频，镜头慢慢推近",
  "帮我写一段赛博朋克夜景的提示词，要出图",
];

export function Composer({
  running,
  uploading,
  disabled,
  placeholder,
  onSend,
  onUpload,
  onInterrupt,
}: {
  running: boolean;
  /** 图上正在传：按钮转圈、别再放进去第二批 */
  uploading?: boolean;
  disabled?: boolean;
  placeholder?: string;
  onSend: (text: string) => void;
  onUpload: (files: File[]) => void;
  onInterrupt: () => void;
}) {
  const [text, setText] = useState("");
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // 一轮正在跑的时候不让传：画布会在中途被换掉，大脑看到的和用户以为的对不上
  const blocked = running || Boolean(disabled) || Boolean(uploading);
  const { active, dropProps } = useFileDrop(!blocked, onUpload);

  function submit() {
    const value = text.trim();
    if (!value || running || disabled) return;
    setText("");
    onSend(value);
    // 高度被撑开过的话收回去，否则下一条消息的输入框还是大的
    if (areaRef.current) areaRef.current.style.height = "auto";
  }

  return (
    <div className={`composer ${active ? "is-drop" : ""}`} {...dropProps}>
      {!text ? (
        <div className="composer-starters">
          {STARTERS.map((starter) => (
            <button
              key={starter}
              type="button"
              className="composer-starter"
              disabled={running || disabled}
              onClick={() => { setText(starter); areaRef.current?.focus(); }}
            >
              <Sparkles size={11} />{starter}
            </button>
          ))}
        </div>
      ) : null}

      <div className="composer-row">
        <button
          type="button"
          className="icon-button composer-attach"
          title="传一张图进来（也可以直接把图拖到这个框里）"
          disabled={blocked}
          onClick={() => fileRef.current?.click()}
        >
          {uploading ? <LoaderCircle size={16} className="spin" /> : <ImagePlus size={16} />}
        </button>
        {/* 系统文件对话框只能按 MIME 提示过滤，真正的把关在服务端（字节头要对得上） */}
        <input
          ref={fileRef}
          className="file-input"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            // 清掉 value：同一个文件连选两次也要能触发第二次 change
            event.target.value = "";
            if (files.length) onUpload(files);
          }}
        />

        <textarea
          ref={areaRef}
          className="composer-input"
          rows={1}
          value={text}
          maxLength={20000}
          disabled={disabled}
          placeholder={placeholder ?? "说你想画什么，要改哪张图，或者传一张图进来…"}
          onChange={(event) => {
            setText(event.target.value);
            // 跟着内容长高，最多 40vh 后自己出滚动条
            const area = event.currentTarget;
            area.style.height = "auto";
            area.style.height = `${Math.min(area.scrollHeight, window.innerHeight * 0.4)}px`;
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey) return;
            // 中文输入法选词的回车不能当成发送
            if (event.nativeEvent.isComposing) return;
            event.preventDefault();
            submit();
          }}
        />
        {running ? (
          <button type="button" className="secondary-button composer-stop" onClick={onInterrupt} title="停下当前这一轮">
            <Square size={13} />停止
          </button>
        ) : (
          <button
            type="button"
            className="primary-button composer-send"
            onClick={submit}
            disabled={!text.trim() || disabled}
            title="发送（回车）"
          >
            <Send size={14} />发送
          </button>
        )}
      </div>

      <div className="composer-hint">
        <CornerDownLeft size={11} />
        <span>回车发送 · Shift + 回车换行</span>
        {uploading ? <span className="composer-hint-run">正在上传图片…</span>
          : running ? <span className="composer-hint-run">助手正在处理…</span> : null}
      </div>
    </div>
  );
}
