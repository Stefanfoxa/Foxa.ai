// Vercel Serverless Function: proxy aman ke Anthropic API (API key tidak pernah sampai ke browser)
module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: "ANTHROPIC_API_KEY belum diset" });

  const { prompt, tier } = req.body || {};
  if (typeof prompt !== "string" || prompt.length < 5 || prompt.length > 8000)
    return res.status(400).json({ error: "prompt tidak valid" });

  const model = tier === "complex"
    ? (process.env.ANTHROPIC_MODEL_GRADE || process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5")
    : (process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5");

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model,
        max_tokens: 3500,
        system: "Kamu asisten dosen Management Control Systems. Balas HANYA dengan satu objek JSON valid, tanpa teks lain dan tanpa markdown.",
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!r.ok) return res.status(502).json({ error: "upstream " + r.status });
    const data = await r.json();
    const text = (data.content || []).map(c => c.text || "").join("").replace(/```json|```/g, "").trim();
    const start = text.indexOf("{"), end = text.lastIndexOf("}");
    return res.status(200).json(JSON.parse(text.slice(start, end + 1)));
  } catch (e) {
    return res.status(500).json({ error: "gagal memproses" });
  }
};
