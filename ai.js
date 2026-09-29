// Vercel Serverless Function: proxy aman ke Anthropic API (API key tidak pernah sampai ke browser)
//
// Perbaikan dari versi sebelumnya:
// - max_tokens dibedakan per tugas: pembuatan soal (generate) butuh ruang lebih besar
//   daripada penilaian (grading/complex), supaya JSON tidak terpotong di tengah (penyebab
//   utama "AI gagal buat soal" sebelumnya).
// - Ekstraksi JSON lebih tangguh: coba parse langsung, lalu coba ambil blok {...} terluar,
//   dan kalau tetap gagal, kembalikan pesan error yang jelas (bukan diam-diam 200 kosong)
//   supaya klien tahu harus retry / fallback ke bank soal, bukan menampilkan hasil kosong.
// - Rate limiting sederhana per-IP (in-memory, best-effort — reset saat cold start,
//   cukup untuk mencegah penyalahgunaan kasar pada endpoint publik).
// - Timeout eksplisit ke Anthropic supaya request yang menggantung tidak membuat
//   pengguna menunggu tanpa kepastian.

const RATE_LIMIT_MAX = 40;       // permintaan
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // per jam per IP
const buckets = new Map(); // ip -> {count, resetAt}   (best-effort, per instance)

function checkRateLimit(ip) {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    buckets.set(ip, b);
  }
  b.count += 1;
  return b.count <= RATE_LIMIT_MAX;
}

function extractJson(text) {
  const cleaned = text.replace(/```json|```/g, "").trim();
  try { return JSON.parse(cleaned); } catch (e) { /* fall through */ }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("no JSON object found in response");
  const slice = cleaned.slice(start, end + 1);
  return JSON.parse(slice); // biarkan melempar jika masih gagal — caller akan menangani
}

async function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const ip = (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: "Terlalu banyak permintaan dari perangkat ini, coba lagi sebentar lagi." });
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: "ANTHROPIC_API_KEY belum diset" });

  const { prompt, tier } = req.body || {};
  if (typeof prompt !== "string" || prompt.length < 5 || prompt.length > 12000)
    return res.status(400).json({ error: "prompt tidak valid" });

  // "generate" (pembuatan soal HOTS) butuh token lebih besar karena bisa berisi beberapa
  // soal + konsep + contoh jawaban sekaligus. "complex" (penilaian) dan default lebih kecil.
  const maxTokens = tier === "generate" ? 4500 : tier === "complex" ? 1800 : 1200;
  const model = tier === "complex"
    ? (process.env.ANTHROPIC_MODEL_GRADE || process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5")
    : (process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5");

  try {
    const r = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: "Kamu asisten dosen Management Control Systems. Balas HANYA dengan satu objek JSON valid dan lengkap (tidak terpotong), tanpa teks lain dan tanpa markdown code fence.",
        messages: [{ role: "user", content: prompt }],
      }),
    }, 28000);

    if (!r.ok) {
      const body = await r.text().catch(() => "");
      return res.status(502).json({ error: `upstream ${r.status}`, detail: body.slice(0, 300) });
    }

    const data = await r.json();
    const stopReason = data.stop_reason;
    const text = (data.content || []).map(c => c.text || "").join("");

    if (!text.trim()) {
      return res.status(502).json({ error: "respons AI kosong" });
    }

    let parsed;
    try {
      parsed = extractJson(text);
    } catch (e) {
      // Kemungkinan besar terpotong karena max_tokens habis di tengah JSON.
      const hint = stopReason === "max_tokens" ? " (terpotong karena batas panjang jawaban tercapai)" : "";
      return res.status(502).json({ error: "gagal mem-parse JSON dari AI" + hint });
    }

    return res.status(200).json(parsed);
  } catch (e) {
    const timedOut = e && e.name === "AbortError";
    return res.status(timedOut ? 504 : 500).json({ error: timedOut ? "permintaan ke AI timeout" : "gagal memproses" });
  }
};
