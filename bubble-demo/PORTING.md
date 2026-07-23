# WebGL2 移植说明

这个目录是 `D:\PGL\cadcg26competition\codes` 中 HarmonyOS/OpenGL ES 3.1
泡泡渲染系统的浏览器适配版，不是独立重写的相似演示。

## 模块对应

| 原工程 | WebGL2 版本 |
| --- | --- |
| `Index.ets` 参数与交互 | `index.html`、`app.js` |
| `napi_init.cpp` 物理、LUT、资源管理 | `physics.js`、`optics.js` |
| `shader_refraction.h` | `renderer.js` 中的球体与连接膜 GLSL ES 3.00 |
| `shader_quad.h` | `renderer.js` 中的最终合成与 ACES pass |
| `rawfile/envmap/*.hdr` | `assets/envmap/*.hdr`（原 2K 资源） |

## WebGL2 平台替代

- OpenGL ES 3.1 `imageLoad/imageStore` 在 WebGL2 中不可用。主体泡泡按相机距离排序，
  逐 RGB 通道使用预乘透明混合，保留彩色薄膜透射率。
- SSBO 在 WebGL2 中不可用。每颗泡泡最多 6 个球冠裁剪平面改由 uniform 数组上传。
- 连接膜与 Plateau 边界继续使用两个 `RGBA16F` 累积目标，分别保存光学厚度与
  光学厚度加权环境反射，最终执行与原工程一致的无序合成。
- HDR 文件由浏览器端 Radiance RGBE/RLE 解码器读入并上传为 `RGBA16F`。

## 已移植功能

- Belcour/Barla 三层薄膜模型与 256×256 LUT
- 四张原始 2K HDR 环境图、白炉测试和 ACES 输出
- 64×64 固定种子 value noise 与三平面膜厚流动
- SI 单位质量、浮力/重力、二次阻力和圆柱容器
- 体积保持 `l=2` 四极形变与 Rayleigh–Lamb 解析积分
- 64 泡泡、6 轮顺序碰撞、冲量、概率爆裂
- XPBD 风格连接、湿度、球冠裁剪、体积补偿
- 曲面共享膜与三圆弧 Plateau 边界
- 观察/互动模式、椭球拾取、软拖拽、局部气流、连接切断和双击爆裂
- 长按 20 个/秒发射与自动展示模式
