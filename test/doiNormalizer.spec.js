const { assert, expect } = require("chai");

describe("DOI normalizer（纯逻辑）", function () {
  let normalizeDOI;

  before(function () {
    normalizeDOI = Zotero.zmtaAddon?.api?.normalizeDOI;
    assert.isFunction(normalizeDOI);
  });

  it("统一裸 DOI、doi: 与 doi.org URL", function () {
    const expected = "10.1000/xyz.abc";
    expect(normalizeDOI(" 10.1000/XYZ.ABC ")).to.equal(expected);
    expect(normalizeDOI("doi: 10.1000/XYZ.ABC")).to.equal(expected);
    expect(normalizeDOI("https://doi.org/10.1000/XYZ.ABC")).to.equal(expected);
    expect(normalizeDOI("http://dx.doi.org/10.1000%2FXYZ.ABC?ignored=1")).to.equal(expected);
  });

  it("拒绝空值、非法前缀、空格和多个 DOI", function () {
    for (const value of [
      "",
      "doi:",
      "11.1000/not-a-doi",
      "10.1000/has space",
      "10.1000/one 10.1000/two",
      "https://example.test/10.1000/xyz",
      null,
    ]) {
      expect(normalizeDOI(value)).to.equal(null);
    }
  });
});
