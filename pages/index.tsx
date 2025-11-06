import { useState } from "react";

export default function Home() {
  const [url, setUrl] = useState("");
  const [history, setHistory] = useState<string[]>(
    typeof window !== "undefined"
      ? JSON.parse(localStorage.getItem("proxyHistory") || "[]")
      : []
  );

  const normalize = (raw: string) => {
    try {
      // Add https if user typed a bare domain
      if (!/^https?:\/\//i.test(raw)) {
        return new URL("https://" + raw).toString();
      }
      return new URL(raw).toString();
    } catch {
      return "";
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const n = normalize(url.trim());
    if (!n) {
      alert("Enter a valid URL, e.g. https://example.com");
      return;
    }
    const updated = [n, ...history.filter(h => h !== n)].slice(0, 8);
    setHistory(updated);
    localStorage.setItem("proxyHistory", JSON.stringify(updated));
    window.location.href = `/api/proxy?url=${encodeURIComponent(n)}`;
  };

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "2rem" }}>
      <h1>Simple Web Proxy</h1>
      <p>Type a website to visit through the proxy.</p>
      <form onSubmit={submit} style={{ display: "flex", gap: "0.5rem" }}>
        <input
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder="https://example.com"
          style={{ flex: 1, padding: "0.75rem" }}
        />
        <button type="submit" style={{ padding: "0.75rem 1rem" }}>
          Go
        </button>
      </form>

      {history.length > 0 && (
        <section style={{ marginTop: "1.5rem" }}>
          <h3>Recent</h3>
          <ul>
            {history.map(h => (
              <li key={h}>
                <a href={`/api/proxy?url=${encodeURIComponent(h)}`}>{h}</a>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section style={{ marginTop: "2rem", color: "#555" }}>
        <p>
          Note: Some sites use Content Security Policy or advanced scripts that
          can break when proxied. This app focuses on simple GET requests and
          basic HTML rewriting.
        </p>
      </section>
    </main>
  );
}
