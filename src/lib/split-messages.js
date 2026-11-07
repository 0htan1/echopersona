/* ==================================================================
 * 把模型的一次输出拆成「连着发的几条消息」
 *
 * 真人聊微信不是写文章：想到一句发一句，屏幕上是一串短气泡。
 * 但模型天然会把话说成一整段 —— 就算提示词要求它换行，前端拿到的
 * 仍然是一个字符串，画出来是一个大气泡，跟微信的观感差很远。
 *
 * 所以要在**服务端**拆成真正的多条消息，各自入库、各自一个气泡。
 *
 * 为什么用 `|||` 而不是让模型直接输出 JSON 数组：
 *   JSON 要模型同时管住「结构 + 内容 + 转义」，实测经常坏在引号、
 *   换行和中文标点上，一坏整条回复就废了。而 `|||` 是纯文本分隔符，
 *   模型写错最多是多几段或少几段，最坏情况退回「一条消息」，
 *   永远不会把内容弄丢。**降级安全比结构正确更重要。**
 * ================================================================== */

/** 模型用来分隔多条消息的标记。 */
export const MULTI_SEPARATOR = '|||';

/* 单条消息的上限。超过就再切一刀 —— 一个 500 字的气泡在手机上很难读，
 * 而且不像真人发出来的。按句末标点切，实在没标点才硬切。 */
const MAX_BUBBLE_CHARS = 180;

/* 一次最多拆几条。真人连发也很少超过 5 条；拆太多会像刷屏，
 * 也会把上下文塞满短消息。 */
export const MAX_BUBBLES = 5;

/**
 * 按句末标点再切一次过长的段落。
 * 只有确实超长才动手，正常短句原样返回。
 */
function splitLongSegment(seg) {
  if (seg.length <= MAX_BUBBLE_CHARS) return [seg];
  const out = [];
  let rest = seg;
  while (rest.length > MAX_BUBBLE_CHARS) {
    /* 在窗口内找最后一个句末标点；找不到就找逗号；再找不到才硬切。
     * 这样切点在语义边界上，切开后每段仍然读得通。 */
    const win = rest.slice(0, MAX_BUBBLE_CHARS);
    let cut = Math.max(
      win.lastIndexOf('。'), win.lastIndexOf('！'), win.lastIndexOf('？'),
      win.lastIndexOf('!'), win.lastIndexOf('?'), win.lastIndexOf('\n'),
    );
    if (cut < MAX_BUBBLE_CHARS * 0.4) cut = Math.max(win.lastIndexOf('，'), win.lastIndexOf(','));
    if (cut < MAX_BUBBLE_CHARS * 0.4) cut = MAX_BUBBLE_CHARS - 1;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

/**
 * 把模型输出拆成多条消息。
 *
 * @param {string} raw 模型原始输出
 * @returns {string[]} 至少一条；空输入返回 []
 */
export function splitIntoMessages(raw) {
  let text = String(raw ?? '').replace(/\r\n/g, '\n').trim();
  if (!text) return [];

  /* 模型有时会把分隔符写坏：`|| |`、`| | |`、`|||`。
   * 不能只认精确的 `|||`，否则一次手抖就退回单条，前面的设计全白费。
   *
   * 顺序很重要：必须先吃掉「带空格的竖线串」，再处理紧凑写法。
   * 反过来的话 `| | |` 会被 `\|{2,}` 先咬掉中间两个，剩下一个孤立的 `|`
   * 留在正文里（实测会输出 "嗯", "| 好" 这种结果）。 */
  const normalized = text
    .replace(/\|(?:\s*\|){1,}/g, MULTI_SEPARATOR)   // | | 、| | | 、|| 与 | 混写
    .replace(/\|{2,}/g, MULTI_SEPARATOR);           // || 或 |||

  let parts = normalized.split(MULTI_SEPARATOR).map((s) => s.trim()).filter(Boolean);

  /* 没有分隔符时，退一步看是否有多行。
   * 但只在「每行都很短、且整体行数合理」时才按行拆 ——
   * 否则一段正常的两行话会被误拆（模型换行常常只是排版）。 */
  if (parts.length === 1 && text.includes('\n')) {
    const rows = text.split('\n').map((s) => s.trim()).filter(Boolean);
    const allShort = rows.every((r) => r.length <= 60);
    if (rows.length > 1 && rows.length <= MAX_BUBBLES && allShort) parts = rows;
  }

  // 逐段再处理超长
  const out = [];
  for (const p of parts) out.push(...splitLongSegment(p));

  return out.slice(0, MAX_BUBBLES).filter(Boolean);
}
