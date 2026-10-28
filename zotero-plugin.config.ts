// Zotero 插件构建配置（zotero-plugin-scaffold 0.8.8）
// 参考官方模板结构，最小化。
import { defineConfig } from "zotero-plugin-scaffold";
import pkg from "./package.json";

const isTestBuild = process.env.NODE_ENV === "test";
const useMockAcquisition = process.env.NODE_ENV === "development"
  && process.env.ZMTA_LIVE_UPSTREAM !== "1";

export default defineConfig({
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: "Zotero 元数据更新",
  xpiName: pkg.name,
  id: "zmta-update-metadata@local",
  namespace: "zmta",
  // 仅测试客户端接收；不把维护者机器路径写入源码或生产插件。
  test: {
    prefs: { "extensions.zmta.testProjectRoot": process.cwd() },
  },
  updateURL: `https://github.com/{{owner}}/{{repo}}/releases/download/release/${pkg.version.includes("-") ? "update-beta.json" : "update.json"}`,
  server: {
    // 让 Zotero.debug 进 stdout（否则 serve 日志看不到插件 debug）
    startArgs: ["-ZoteroDebugText"],
    devtools: true,
  },
  build: {
    prefs: {
      prefix: "extensions.zmta",
    },
    define: {
      // 注入构建版本（buildVersion 来自 package.json version + 构建时间），
      // 供插件显示/日志，用于分辨 serve 跑的是不是最新版
      __buildVersion__: `"${pkg.version}"`,
      __buildTime__: `"${new Date().toISOString()}"`,
      __testBuild__: String(isTestBuild),
      __mockAcquisition__: String(useMockAcquisition),
    },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        outfile: `.scaffold/build/addon/content/scripts/zmta.js`,
        bundle: true,
        target: "firefox115",
        // 用 iife：Zotero 用 loadSubScript 加载普通脚本，不能有 module/exports
        format: "iife",
        // 消除生产构建的 if(false) 测试分支，便于包内容检查且不改变测试模式。
        minifySyntax: true,
        define: {
          __buildVersion__: `"${pkg.version}"`,
          __buildTime__: `"${new Date().toISOString()}"`,
          __testBuild__: String(isTestBuild),
          __mockAcquisition__: String(useMockAcquisition),
        },
      },
    ],
    assets: ["addon/**/*.*"],
  },
});
