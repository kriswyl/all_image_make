/**
 * 新用户向导。
 *
 * 只在**一个渠道都没有**、而且用户还没点「先自己看看」时占据主区。
 *
 * 刻意不做成多步遮罩向导：真正需要配的东西只有一样——一个中转渠道（Base URL + Key），
 * 而 `AddChannelWizard` 已经把这件的每一步都做好了（选预设、填 key、测连通）。
 * 再套一层「下一步、下一步」只是把同一件事说两遍，用户还得点两次才能到真正的表单。
 * 这里要解决的是**第一次打开不知道从哪下手**：说清它是干什么的，然后把人送到那个按钮前。
 */
import { Film, Image as ImageIcon, KeyRound, MessageSquarePlus, Server, Sparkles } from "lucide-react";

const STEPS = [
  {
    icon: <Server size={17} />,
    title: "接入一个渠道",
    body: "填中转站的 Base URL 和 API Key。密钥只留在本机，不会进数据库、也不会写进任何日志。",
  },
  {
    icon: <KeyRound size={17} />,
    title: "挑要用的模型",
    body: "同一个渠道下的模型由你勾选。生图和生视频可以来自不同渠道，互不影响。",
  },
  {
    icon: <Sparkles size={17} />,
    title: "开始创作",
    body: "想省事就直接对话：「画一只戴草帽的橘猫」，助手会自己挑模型、自己改图。",
  },
];

export function WelcomeView({ onStart, onSkip }: { onStart: () => void; onSkip: () => void }) {
  return (
    <div className="page welcome-page">
      <div className="welcome-hero">
        <img className="welcome-logo" src="/brand-mark.png" alt="" width={52} height={52} draggable={false} />
        <h1>欢迎使用语布</h1>
        <p className="welcome-slogan">马中赤兔，创中语布</p>
        <p>
          一个跑在你自己电脑上的图片 / 视频生成客户端。渠道、密钥、产物全部留在本机，
          中转站只看到你发出去的那次请求。
        </p>
      </div>

      <div className="welcome-capabilities">
        <span><ImageIcon size={14} />文生图 · 图生图 · 最多 8 张参考图</span>
        <span><Film size={14} />万相 / Seedance / Grok 三种视频协议</span>
        <span><MessageSquarePlus size={14} />一句话让助手自己决定画图还是改图</span>
      </div>

      <ol className="welcome-steps">
        {STEPS.map((step, index) => (
          <li key={step.title}>
            <span className="welcome-step-index">{index + 1}</span>
            <div className="welcome-step-body">
              <h2>{step.icon}{step.title}</h2>
              <p>{step.body}</p>
            </div>
          </li>
        ))}
      </ol>

      <div className="welcome-actions">
        <button type="button" className="primary-button" onClick={onStart}>
          <Server size={16} />添加第一个渠道
        </button>
        <button type="button" className="link-btn" onClick={onSkip}>
          先自己看看界面
        </button>
      </div>
    </div>
  );
}
