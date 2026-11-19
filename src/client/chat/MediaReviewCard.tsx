import { Film, Play } from "lucide-react";
import { mediaTime, type MediaReview, type VideoOverview } from "../../shared/media-review";
import "./media-review.css";

export function VideoOverviewCard({ overview, onSeek }: {
  overview: VideoOverview;
  onSeek?: (assetId: string, startMs: number) => void;
}) {
  const complete = overview.timesMs.length === overview.planned;
  return (
    <details className="media-review">
      <summary title={overview.title}>
        <Film size={15} />
        <strong>全片画面取样</strong>
        <span>{mediaTime(overview.durationMs)} · {complete ? overview.timesMs.length : `${overview.timesMs.length}/${overview.planned}`} 帧</span>
      </summary>
      <div className="media-review-segment">
        <div className="media-review-samples">
          {overview.timesMs.map(time => (
            <button key={time} type="button" className="media-review-seek" disabled={!onSeek} onClick={() => onSeek?.(overview.assetId, time)} title="跳到原片">
              <Play size={11} />{mediaTime(time, true)}
            </button>
          ))}
        </div>
        {!complete ? <p className="media-review-note">部分位置未取到画面。</p> : null}
        <p className="media-review-note">概述依据为抽样画面，未读取音轨。</p>
      </div>
    </details>
  );
}

/** 旧审阅记录仍然可以展开及回看时间码。 */
export function MediaReviewCard({ review, onSeek }: {
  review: MediaReview;
  onSeek?: (assetId: string, startMs: number) => void;
}) {
  const read = review.segments.filter(segment => segment.visual || segment.speech).length;
  return (
    <details className="media-review">
      <summary>
        <Film size={15} />
        <strong>{review.startMs === 0 && review.endMs === review.durationMs ? review.kind === "video" ? "全片时间轴" : "音频时间轴" : "片段时间轴"}</strong>
        <span>{read}/{review.segments.length} 段有记录</span>
      </summary>
      <ol className="media-review-timeline">
        {review.segments.map(segment => (
            <li key={segment.startMs} className="media-review-segment">
              <div className="media-review-segment-head">
                <button type="button" className="media-review-seek" disabled={!onSeek} onClick={() => onSeek?.(review.assetId, segment.startMs)} title="跳到原片">
                  <Play size={12} />
                  {mediaTime(segment.startMs, true)}–{mediaTime(segment.endMs, true)}
                </button>
                {segment.frameTimesMs.length ? <span>{segment.frameTimesMs.length} 帧</span> : null}
              </div>
              {segment.pending ? <p className="media-review-note">尚未读取</p> : null}
              {segment.visual ? <p>{segment.visual}</p> : null}
              {segment.frameTimesMs.length ? (
                <details className="media-review-dialogue">
                  <summary>画面取样</summary>
                  <div className="media-review-samples">
                    {segment.frameTimesMs.map(time => (
                      <button key={time} type="button" className="media-review-seek" disabled={!onSeek} onClick={() => onSeek?.(review.assetId, time)}>{mediaTime(time, true)}</button>
                    ))}
                  </div>
                </details>
              ) : null}
              {segment.speech?.length ? (
                <details className="media-review-dialogue">
                  <summary>{segment.speechSource === "subtitles" ? "原片字幕" : "对白转写"} · {segment.speech.length} 条</summary>
                  <ul>
                    {segment.speech.map((line, index) => (
                      <li key={`${line.startMs}-${index}`}>
                        <button type="button" className="media-review-seek" disabled={!onSeek} onClick={() => onSeek?.(review.assetId, line.startMs)}>{mediaTime(line.startMs, true)}</button>
                        <span>{line.text}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : segment.speech ? <p className="media-review-note">此段未找到对白</p> : null}
              {segment.visualIssue ? <p className="media-review-note">{segment.visualIssue}</p> : null}
              {segment.audioIssue ? <p className="media-review-note">{segment.audioIssue}</p> : null}
            </li>
        ))}
      </ol>
    </details>
  );
}
