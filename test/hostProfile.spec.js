const { expect } = require("chai");
const { assertDedicatedTestProfile } = require("./hostProfile.cjs");

describe("宿主测试路径保护", function () {
  function fixture(root = "/workspace/project", profile, data) {
    return [
      { Prefs: { get: () => root }, DataDirectory: { dir: data ?? `${root}/.scaffold/test/data` } },
      { dirsvc: { get: () => ({ path: profile ?? `${root}/.scaffold/test/profile` }) } },
      { nsIFile: {} },
    ];
  }

  it("接受运行器绑定的隔离目录及Windows路径", function () {
    expect(() => assertDedicatedTestProfile(...fixture())).not.to.throw();
    expect(() => assertDedicatedTestProfile(...fixture("C:\\workspace\\project"))).not.to.throw();
  });
  it("缺少项目根或使用相对／含上级目录的根时拒绝", function () {
    for (const root of [undefined, "", "/", "relative", "C:\\", "/workspace/../project"]) {
      const args = fixture(root);
      args[0].Prefs.get = () => root;
      expect(() => assertDedicatedTestProfile(...args)).to.throw();
    }
  });
  it("profile或dataDir任意一项不匹配就拒绝", function () {
    expect(() => assertDedicatedTestProfile(...fixture("/workspace/project", "/other/profile"))).to.throw();
    expect(() => assertDedicatedTestProfile(...fixture("/workspace/project", undefined, "/other/data"))).to.throw();
    expect(() => assertDedicatedTestProfile(...fixture("/workspace/project", "/workspace/project-other/.scaffold/test/profile"))).to.throw();
  });
});
