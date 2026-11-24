// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vite-plus/test";
import { dragWheel, pagePoint, siteOf } from "./browser.ts";

describe("siteOf", () => {
  it("names a page by its host, without www", () => {
    expect(siteOf("https://www.example.com/login?next=/")).toBe("example.com");
    expect(siteOf("http://accounts.example.org:8080/")).toBe("accounts.example.org");
  });

  it("names nothing for a tab with no web page", () => {
    for (const url of ["", "about:blank", "chrome://settings", "not an address"]) {
      expect(siteOf(url), url).toBe("");
    }
  });
});

describe("pagePoint", () => {
  // A 1280×800 page drawn 400 wide under a 40-point bar, then zoomed twice and moved.
  const page = { width: 1280, height: 800 };

  it("maps through the page's size, whatever the picture's scale", () => {
    const drawn = { left: 0, top: 40, width: 400, height: 250 };
    expect(pagePoint({ x: 200, y: 165 }, drawn, page)).toEqual({ x: 640, y: 400 });
    expect(pagePoint({ x: 0, y: 40 }, drawn, page)).toEqual({ x: 0, y: 0 });
  });

  it("follows the picture when it is zoomed and moved", () => {
    const zoomed = { left: -200, top: -85, width: 800, height: 500 };
    expect(pagePoint({ x: 200, y: 165 }, zoomed, page)).toEqual({ x: 640, y: 400 });
  });

  it("refuses a point off the picture, as on the letterbox", () => {
    const drawn = { left: 0, top: 40, width: 400, height: 250 };
    expect(pagePoint({ x: 200, y: 20 }, drawn, page)).toBeNull();
    expect(pagePoint({ x: 200, y: 300 }, drawn, page)).toBeNull();
  });
});

describe("dragWheel", () => {
  it("scrolls the page the other way from the finger, in page pixels", () => {
    const drawn = { left: 0, top: 0, width: 400, height: 250 };
    expect(dragWheel({ x: 0, y: -100 }, drawn, { width: 1280, height: 800 })).toEqual({
      x: 0,
      y: 320,
    });
  });
});
