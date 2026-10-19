"""
把捕获的 PNG 帧合成 GIF

用法：python docs/make-gif.py

做了几件事让 GIF 更小更清晰：
  1. 用中位切分量化（median cut）而不是固定调色板，颜色更准
  2. 只在调色板变化时重新生成，降低体积
  3. 每帧单独优化（optimize），去掉重复像素
"""
import os
import sys
import glob
from PIL import Image, ImageSequence

ROOT = os.path.dirname(os.path.abspath(__file__))
FRAMES_DIR = os.path.join(ROOT, "gif-frames")
OUT_GIF = os.path.join(ROOT, "demo.gif")

# 播放节奏（毫秒/帧）。36 帧 × 90ms ≈ 3.2 秒，节奏适中
FRAME_MS = 90
# 最后一帧停留久一点，方便看清五朵花
HOLD_LAST_MS = 900
# 缩放：GIF 原始 800x500 太大，缩到 640 宽
TARGET_W = 640
MAX_COLORS = 96   # 深色背景 + 粉色花朵，96 色足够且体积小


def main():
    files = sorted(glob.glob(os.path.join(FRAMES_DIR, "frame-*.png")))
    if not files:
        print(f"错误：{FRAMES_DIR} 里没有帧文件")
        return 1

    print(f"找到 {len(files)} 帧")

    frames = []
    for f in files:
        im = Image.open(f).convert("RGB")
        if im.width != TARGET_W:
            h = round(im.height * TARGET_W / im.width)
            im = im.resize((TARGET_W, h), Image.LANCZOS)
        frames.append(im)

    # 用第一帧生成自适应调色板，之后所有帧共用（避免逐帧调色板闪烁）
    # 但为了质量，改用「全部帧一起量化」的方式
    print("生成调色板...")
    # 采样所有帧的像素做统一量化
    sample = Image.new("RGB", (TARGET_W, frames[0].height * len(frames)))
    for i, im in enumerate(frames):
        sample.paste(im, (0, i * frames[0].height))
    pal_img = sample.quantize(colors=MAX_COLORS, method=Image.MEDIANCUT)
    palette = pal_img.getpalette()

    print("转换每一帧...")
    pal_frames = []
    for im in frames:
        p = im.quantize(palette=pal_img, dither=Image.FLOYDSTEINBERG)
        pal_frames.append(p)

    durations = [FRAME_MS] * (len(pal_frames) - 1) + [HOLD_LAST_MS]

    print("写入 GIF...")
    pal_frames[0].save(
        OUT_GIF,
        save_all=True,
        append_images=pal_frames[1:],
        duration=durations,
        loop=0,                 # 无限循环
        optimize=True,
        disposal=2,             # 每帧前清空，避免残影
    )

    size_kb = os.path.getsize(OUT_GIF) / 1024
    print(f"\n完成: {OUT_GIF}")
    print(f"  尺寸: {TARGET_W}x{frames[0].height}")
    print(f"  帧数: {len(pal_frames)}")
    print(f"  时长: {sum(durations)/1000:.1f}s")
    print(f"  体积: {size_kb:.0f} KB ({size_kb/1024:.2f} MB)")

    if size_kb > 8000:
        print("  ⚠ 超过 8MB，建议减少帧数或降低尺寸")

    return 0


if __name__ == "__main__":
    sys.exit(main())
