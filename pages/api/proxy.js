import * as cheerio from "cheerio";

// Ensure absolute URLs
function toAbsolute(url, base) {
  try {
    return new URL(url, base).toString();
  } catch {
    return url;
  }
}

// Wrap target URL so it routes through proxy
function wrap(url) {
  return `/api/proxy?url=${encodeURIComponent(url)}`;
}

// Rewrite HTML: adjust links/resources
function rewriteHtml(html, baseUrl) {
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
    ["form", "action"],
  ];

  for (const [tag, attr] of attrTargets) {
    $(tag).each((_, el) => {
      const value = $(el).attr(attr);
      if (!value) return;
      if (value.startsWith("#")) return;
      const low = value.toLowerCase();
      if (
        low.startsWith("mailto:") ||
        low.startsWith("tel:") ||
        low.startsWith("javascript:")
      )
        return;

      const abs = toAbsolute(value, baseUrl);
      if (tag === "form") {
        $(el).attr("method", "GET");
      }
      $(el).attr(attr, wrap(abs));
    });
  }

  // Inline CSS url(...) references
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

  // Inject toolbar
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

// Filter headers
function filterResponseHeaders(headers) {
  const out = {};
  const hopByHop = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]);

  headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (hopByHop.has(k)) return;
    if (k === "content-security-policy" || k === "x-frame-options") return;
    if (k === "set-cookie") return;
    out[key] = value;
  });

  if (!Object.keys(out).some((k) => k.toLowerCase() === "content-type")) {
    out["Content-Type"] = "text/plain; charset=utf-8";
  }

  return out;
}

export default async function handler(req, res) {
  const target = req.query.url || "";
  if (!target) {
    res.status(400).send("Missing ?url= parameter");
    return;
  }

  let url;
  try {
    url = new URL(target);
  } catch {
    res.status(400).send("Invalid URL");
    return;
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    res.status(400).send("Only http/https supported");
    return;
  }

  try {
    const upstream = await fetch(url.toString(), {
      method: "GET",
      redirect: "follow",
      headers: {
        "user-agent":
          req.headers["user-agent"] ||
          "Mozilla/5.0 (Proxy) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
        accept: req.headers["accept"] || "*/*",
        "accept-language": req.headers["accept-language"] || "en-US,en;q=0.9",
      },
    });

    const status = upstream.status;
    const headers = filterResponseHeaders(upstream.headers);

    const contentType = upstream.headers.get("content-type") || "";
    const isHtml = contentType.includes("text/html");

    if (!isHtml) {
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
  } catch (err) {
    res.status(502).send(`Upstream fetch failed: ${err.message || String(err)}`);
  }
}
