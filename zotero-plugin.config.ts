import { defineConfig } from "zotero-plugin-scaffold";
import pkg from "./package.json";

const isPreRelease = pkg.version.includes("-");

export default defineConfig({
  source: ["src", "addon"],
  dist: "build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  xpiName: pkg.name,
  updateURL: isPreRelease
    ? pkg.config.updateJSON.replace("update.json", "update-beta.json")
    : pkg.config.updateJSON,
  xpiDownloadLink: `${pkg.config.releasePage}/download/v{{version}}/{{xpiName}}.xpi`,

  build: {
    assets: ["addon/**/*.*"],
    define: {
      ...pkg.config,
      author: pkg.author,
      description: pkg.description,
      homepage: pkg.homepage,
      buildVersion: pkg.version,
      buildTime: "{{buildTime}}",
      updateURL: isPreRelease
        ? pkg.config.updateJSON.replace("update.json", "update-beta.json")
        : pkg.config.updateJSON,
    },
    prefs: {
      prefix: pkg.config.prefsPrefix,
    },
    makeManifest: {
      enable: false,
    },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        define: {
          __env__: `"${process.env.NODE_ENV ?? "production"}"`,
        },
        bundle: true,
        target: "firefox115",
        outfile: `addon/chrome/content/scripts/${pkg.config.addonRef}.js`,
        minify: process.env.NODE_ENV === "production",
      },
    ],
  },

  server: {
    asProxy: true,
    createProfileIfMissing: false,
  },

  test: {
    waitForPlugin: `() => Zotero.${pkg.config.addonInstance}.data.alive`,
  },
});
