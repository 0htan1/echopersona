"""生成 GitHub Social preview 图（1280×640）。

GitHub 的社交预览图没有 API，只能在后台上传。这张图就是分享到
Twitter / 微信 / Slack 时显示的那张缩略图 —— 它决定了别人点不点进来，
所以不用"字大色艳"的封面套路，而是直接用 App 的真实配色和真实截图，
让人一眼看出这是个什么样的产品。

配色取自 public/css/app.css：暖米色底 + 近黑墨色 + 赭红强调色。
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "images" / "social-preview.png"

W, H = 1280, 640
CREAM = (246, 242, 236)
INK = (23, 19, 16)
RUST = (184, 73, 31)
MUTED = (122, 112, 103)
LINE = (226, 217, 206)

BOLD = "C:/Windows/Fonts/msyhbd.ttc"
REG = "C:/Windows/Fonts/msyh.ttc"


def font(path, size):
    return ImageFont.truetype(path, size, index=0)


def rounded(img, radius):
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, img.size[0] - 1, img.size[1] - 1], radius, fill=255
    )
    out = img.convert("RGBA")
    out.putalpha(mask)
    return out


def main():
    card = Image.new("RGB", (W, H), CREAM)
    d = ImageDraw.Draw(card)

    # 极淡的网点纹理，避免大面积纯色显得廉价
    for y in range(0, H, 26):
        for x in range(0, W, 26):
            d.ellipse([x, y, x + 1, y + 1], fill=(238, 232, 224))

    # ---- 右侧：真实截图 ----
    shot = Image.open(ROOT / "docs" / "images" / "chat.png").convert("RGB")
    sw, sh = shot.size
    # 只取聊天主区域：左边 37% 是图标导航 + 会话列表，切进去会露出半个侧栏；
    # 右边界必须贴到画布最右，否则右对齐的绿色气泡会被切掉半截；
    # 下边界停在第 5 条对话之后，避开输入框（那里全是小字，缩到 616 宽就糊了）。
    crop = shot.crop((int(sw * 0.370), 0, sw, int(sh * 0.800)))

    target_w = 616
    crop = crop.resize((target_w, int(crop.height * target_w / crop.width)), Image.LANCZOS)

    px, py = 604, 96
    cw, ch = crop.size

    # 错位的浅色块当"纸叠纸"，让卡片有厚度
    plate = Image.new("RGBA", (cw + 40, ch + 40), (0, 0, 0, 0))
    pd = ImageDraw.Draw(plate)
    pd.rounded_rectangle([14, 18, cw + 34, ch + 38], 20, fill=(60, 48, 38, 30))
    card.paste(plate.convert("RGB"), (px - 14, py - 18), plate.split()[3])
    card.paste(crop, (px, py), rounded(crop, 18))
    d.rounded_rectangle(
        [px, py, px + cw - 1, py + ch - 1],
        radius=18, outline=(210, 199, 186), width=1,
    )

    # ---- 左侧文字 ----
    x = 74
    y = 120

    d.text((x, y), "E C H O P E R S O N A", font=font(BOLD, 17), fill=RUST)
    y += 42

    f_title = font(BOLD, 50)
    for line in ["把一段真实的", "聊天记录，还原成"]:
        d.text((x, y), line, font=f_title, fill=INK)
        y += 64
    d.text((x, y), "能继续对话的 AI 人格", font=f_title, fill=RUST)
    y += 74

    d.line([x, y, x + 92, y], fill=(203, 191, 177), width=2)
    y += 28

    f_sub = font(REG, 23)
    for line in ["先测量，再模仿。",
                 "统计语言风格 + 检索真实原话，",
                 "而不是让模型演一个泛泛的朋友。"]:
        d.text((x, y), line, font=f_sub, fill=MUTED)
        y += 37

    # ---- 底部技术栈 ----
    f_tag = font(REG, 18)
    tx = x
    for t in ["Node 22", "Fastify 5", "SQLite FTS5", "MIT"]:
        tw = d.textlength(t, font=f_tag)
        d.rounded_rectangle([tx, H - 84, tx + tw + 24, H - 50], radius=17, outline=LINE, width=1)
        d.text((tx + 12, H - 74), t, font=f_tag, fill=(107, 98, 89))
        tx += tw + 34

    OUT.parent.mkdir(parents=True, exist_ok=True)
    card.save(OUT, optimize=True)
    print(f"wrote {OUT}  {OUT.stat().st_size} B  {card.size}")


if __name__ == "__main__":
    main()
