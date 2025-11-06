import type { NextApiRequest, NextApiResponse } from "next";
import * as cheerio from "cheerio";

// Helper: ensure absolute URLs
function toAbsolute(url: string, base: string) {
  try {
    return new URL(url, base).toString();
  } catch {
    return url;
  }
}

// Wrap a target URL so it routes through our proxy
function wrap(url: string) {
  return `/api/proxy?url=${encodeURIComponent(url)}`;
}

// Rewrite HTML: make links absolute, then wrap them
function rewriteHtml(html: string, baseUrl: string) {
  const $ = cheerio.load(html, { decodeEntities: false });

  const attrTargets = [
    ["a", "href"],
    ["link", "href"],
    ["img", "src"],
    ["script", "src"],
    ["iframe", "src"],
    ["source", "src"],
    ["video", "src"],
    ["audio", "src"],
    ["form", "action"]
  ];

  for (const [tag, attr] of attrTargets) {
    $(tag).each((_, el) => {
      const value = $(el).attr(attr);
      if (!value) return;

      // Skip anchors, mailto, javascript: etc.
      if (value.startsWith("#")) return;
      const low = value.toLowerCase();
      if (low.startsWith("mailto:") || low.startsWith("tel:") || low.startsWith("javascript:")) return;

      const abs = toAbsolute(value, baseUrl);

      // For forms, we only support GET; force method=GET
      if (tag === "form") {
        $(el).attr("method", "GET");
      }

      $(el).attr(attr, wrap(abs));
    });
  }

  // Make all inline CSS url(...) references route through proxy (basic pass)
  $("style").each((_, el) => {
    const css = $(el).html() || "";
    const replaced = css.replace(/url\(([^)]+)\)/g, (match, p1) => {
      const raw = p1.trim().replace(/^['"]|['"]$/g, "");
      if (raw.startsWith("data:")) return match;
      const abs = toAbsolute(raw, baseUrl);
      return `url(${wrap(abs)})`;
    });
    $(el).html(replaced);
  });

  // Inject a lightweight toolbar
  $("body").prepend(`
    <div id="proxy-bar" style="position:fixed;top:0;left:0;right:0;background:#111;color:#eee;font:14px/1.4 sans-serif;padding:8px;z-index:999999;">
      <form action="/api/proxy" method="GET" style="display:flex;gap:8px;">
        <input type="text" name="url" value="${baseUrl}" style="flex:1;padding:6px;border-radius:4px;border:1px solid #333;background:#222;color:#eee;" />
        <button type="submit" style="padding:6px 10px;border-radius:4px;background:#444;color:#eee;border:1px solid #333;">Go</button>
        <span style="margin-left:auto;opacity:0.8">Proxying: ${baseUrl}</span>
      </form>
    </div>
    <style>html,body{margin-top:40px !important}</style>
  `);

  return $.html();
}

// Pass through selected headers but avoid hop-by-hop or security conflicts
function filterResponseHeaders(headers: Headers) {
  const out: Record<string, string> = {};
  const hopByHop = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade"
  ]);

  headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (hopByHop.has(k)) return;

    // Avoid CSP/X-Frame-Options that can block rendering
    if (k === "content-security-policy" || k === "x-frame-options") return;

    // Cookies from origin are ignored in this minimal build
    if (k === "set-cookie") return;

    out[key] = value;
  });

  // Always set a content-type fallback
  if (!Object.keys(out).some(k => k.toLowerCase() === "content-type")) {
    out["Content-Type"] = "text/plain; charset=utf-8";
  }

  return out;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const target = (req.query.url as string) || "";
  if (!target) {
    res.status(400).send("Missing ?url= parameter");
    return;
  }

  let url: URL;
  try {
    url = new URL(target);
  } catch {
    res.status(400).send("Invalid URL");
    return;
  }

  // Only allow http/https
  if (!["http:", "https:"].includes(url.protocol)) {
    res.status(400).send("Only http/https supported");
    return;
  }

  try {
    // Forward basic headers; you can add more based on req
    const upstream = await fetch(url.toString(), {
      method: "GET",
      redirect: "follow",
      headers: {
        "user-agent":
          req.headers["user-agent"] ||
          "Mozilla/5.0 (Proxy) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
        "accept": req.headers["accept"] || "*/*",
        "accept-language": req.headers["accept-language"] || "en-US,en;q=0.9"
      }
    });

    const status = upstream.status;
    const headers = filterResponseHeaders(upstream.headers);

    const contentType = upstream.headers.get("content-type") || "";
    const isHtml = contentType.includes("text/html");

    if (!isHtml) {
      // Stream non-HTML responses (images, CSS, JS) directly but still via proxy
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.setHeader("Content-Type", contentType || "application/octet-stream");
      Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
      res.status(status).send(buf);
      return;
    }

    const text = await upstream.text();
    const rewritten = rewriteHtml(text, url.toString());

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
    res.status(status).send(rewritten);
  } catch (err: any) {
    res.status(502).send(`Upstream fetch failed: ${err?.message || String(err)}`);
  }
}
