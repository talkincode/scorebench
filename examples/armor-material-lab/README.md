# 装甲材质实验场

独立验证 Voyage 装甲材质管线，不渲染战舰，也不修改战舰拓扑。实验场只有一块近距离倒角装甲板；无 Bloom、无轮廓线、无 HDR 环境贴图，固定相机、曝光和灯位。

材质不依赖 UV。旧漆、裸钢、接缝、掉漆、锈蚀、锈水、油污、烧蚀、粗糙度、微法线和 AO 全部来自 object-space triplanar 程序特征。锈蚀的生成源限定为接缝核心、凹槽唇和实体边缘，锈水再从这些结构源沿重力方向向下延伸。

## 运行

```sh
npm run demo:armor
# http://127.0.0.1:5177/
```

按 `1`–`7` 或点击右下菜单查看：

1. Base Color
2. Roughness
3. Metalness
4. Normal
5. AO
6. Weathering Mask
7. Final PBR

固定截图可直接使用 `?view=base-color|roughness|metalness|normal|ao|weathering|final`。Weathering Mask 的 RGB 语义为：红 = 锈蚀/锈水，绿 = 掉漆/裸钢，蓝 = 油污/烧蚀。

只有七个通道和 Final PBR 都通过肉眼检查后，材质函数才允许迁移到整艘战舰。
