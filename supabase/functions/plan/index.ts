// trip-consulting の旅程を作る Edge Function（Lovable Cloud / Supabase）
//
// 流れ：
//   1. 行きたい場所から検索語を作り、Redpine で交通・現地の最新記事を探す
//   2. 見つかった記事を [R1] [R2] … と番号付きでプロンプトに足し、AI に旅程JSONを作らせる
//   3. AI が実際に引用した記事だけを plan.sources として返す（関係ない記事は画面に出さない）
//
// 必要なシークレット（Lovable Cloud の Secrets に登録）：
//   REDPINE_API_KEY     Redpine の API キー（sk_live_… / sk_test_…）。無ければ Redpine なしで旅程だけ作る
//   LOVABLE_API_KEY     Lovable AI を有効にすると自動で入る。代わりに ANTHROPIC_API_KEY でも動く
// 任意：
//   REDPINE_COLLECTIONS 検索するコレクション名（カンマ区切り、最大5）。未指定なら一覧から自動で選ぶ
//   REDPINE_MODE        "query"（既定。全文・従量課金）か "preview"（無料・抜粋のみ）
//   AI_MODEL            既定 google/gemini-3.7-flash（Lovable AI）/ claude-haiku-5-5（Anthropic）

const REDPINE = "https://api.redpine.ai/api/v1";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

type Form = { origin?: string; ret?: string; start?: string; end?: string; people?: string | number; prio?: string; dest?: string; wish?: string };
type Source = { id: string; title: string; publisher: string; date: string; url: string; text: string; collection: string; relevance: number; locked: boolean; query: string };

// ---------- Redpine ----------
async function redpine(path: string, key: string, body?: unknown) {
  const res = await fetch(REDPINE + path, {
    method: body ? "POST" : "GET",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Redpine ${path} ${res.status} ${data?.error?.code || data?.error || data?.message || ""}`.trim());
  return data;
}

const TOPICAL = /news|press|journal(ism)?|media|travel|touris|transport|rail|airline|aviation|ferry|japan|jp|nikkei|asia|ニュース|新聞|報道|旅行|観光|交通|鉄道|航空|日本/i;

async function pickCollections(key: string): Promise<string[]> {
  const fixed = (Deno.env.get("REDPINE_COLLECTIONS") || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (fixed.length) return fixed.slice(0, 5);
  const data = await redpine("/search/collections", key);
  const list: { name: string; description?: string }[] = Array.isArray(data?.collections) ? data.collections : [];
  const topical = list.filter((c) => TOPICAL.test(`${c.name} ${c.description || ""}`));
  return (topical.length ? topical : list).slice(0, 5).map((c) => c.name);
}

function queriesFor(f: Form): string[] {
  const places = String(f.dest || "").split(/\n/).map((s) => s.replace(/[（(].*?[)）]/g, "").trim()).filter(Boolean).slice(0, 3);
  const month = f.start ? `${Number(f.start.slice(5, 7))}月` : "";
  const q = places.map((p) => `${p} 交通 運休 欠航 工事 ${month}`.trim());
  if (places.length) q.push(`${places.join(" ")} 観光 イベント 混雑 料金 ${month}`.trim());
  return q.slice(0, 4);
}

function toSource(r: any, query: string): Omit<Source, "id"> {
  const m = r?.metadata || {};
  const text = r?.text || r?.snippet || (Array.isArray(r?.chunks) ? r.chunks.map((c: any) => c.text || c.snippet || "").join(" ") : "");
  return {
    title: String(m.title || r?.title || ""),
    publisher: String(m.publisher || m.source || r?.publisher || m.journal || r?.journal || ""),
    date: String(m.publication_date || m.publicationDate || r?.publication_date || m.year || r?.year || "").slice(0, 10),
    url: String(m.url || r?.url || (m.doi || r?.doi ? `https://doi.org/${m.doi || r?.doi}` : "")),
    text: String(text).replace(/\s+/g, " ").trim().slice(0, 900),
    collection: String(r?.collection || ""),
    relevance: Number(r?.relevance ?? 0),
    locked: !!r?.locked,
    query,
  };
}

async function findNews(f: Form) {
  const key = Deno.env.get("REDPINE_API_KEY");
  const mode = Deno.env.get("REDPINE_MODE") === "preview" ? "preview" : "query";
  const info = { mode, collections: [] as string[], checkedAt: new Date(Date.now() + 9 * 36e5).toISOString().replace("Z", "+09:00"), note: "" };
  if (!key) return { sources: [] as Source[], info: { ...info, note: "Redpine の API キーが未設定のため、最新情報は調べていません。" } };
  try {
    info.collections = await pickCollections(key);
    if (!info.collections.length) return { sources: [], info: { ...info, note: "この API キーで検索できる Redpine のコレクションがありません。" } };
    const qs = queriesFor(f);
    const settled = await Promise.allSettled(qs.map((query) =>
      redpine(`/search/${mode}`, key, { query, collections: info.collections, limit: 4 })
        .then((d) => (Array.isArray(d?.results) ? d.results : []).map((r: any) => toSource(r, query)))
    ));
    const all = settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
    const errors = settled.filter((s) => s.status === "rejected").map((s: any) => String(s.reason?.message || s.reason));
    const seen = new Set<string>();
    const uniq = all
      .filter((s) => s.text || s.title)
      .filter((s) => { const k = s.url || s.title; if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, 10)
      .map((s, i) => ({ id: `R${i + 1}`, ...s }));
    if (!uniq.length) info.note = errors.length ? `Redpine の検索に失敗しました（${errors[0]}）。` : "この旅程に関係する記事は見つかりませんでした。";
    return { sources: uniq, info };
  } catch (e) {
    return { sources: [], info: { ...info, note: `Redpine に接続できませんでした（${(e as Error).message}）。旅程は最新情報なしで作っています。` } };
  }
}

// ---------- AI ----------
async function askAI(system: string, user: string): Promise<string> {
  const lovable = Deno.env.get("LOVABLE_API_KEY");
  const anthropic = Deno.env.get("ANTHROPIC_API_KEY");
  if (lovable) {
    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${lovable}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: Deno.env.get("AI_MODEL") || "google/gemini-3.7-flash", messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
      signal: AbortSignal.timeout(110000),
    });
    const d = await res.json().catch(() => ({}));
    if (res.status === 429) throw new Error("AIの利用が混み合っています。少し待ってからもう一度");
    if (res.status === 402) throw new Error("Lovable AI のクレジットが足りません");
    if (!res.ok) throw new Error(`AI ${res.status} ${d?.error?.message || ""}`.trim());
    return d?.choices?.[0]?.message?.content || "";
  }
  if (anthropic) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": anthropic, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({ model: Deno.env.get("AI_MODEL") || "claude-haiku-5-5", max_tokens: 8000, system, messages: [{ role: "user", content: user }] }),
      signal: AbortSignal.timeout(110000),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`AI ${res.status} ${d?.error?.message || ""}`.trim());
    return (d?.content || []).map((c: any) => c.text || "").join("");
  }
  throw new Error("AIのキーが未設定です（Lovable AI を有効にするか ANTHROPIC_API_KEY を登録）");
}

function parsePlan(raw: string) {
  let s = String(raw || "").trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1];
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error("JSONが見つからない");
  const p = JSON.parse(s.slice(a, b + 1));
  const plan = p?.plan && Array.isArray(p.plan.days) ? p.plan : p;
  if (!Array.isArray(plan?.days) || !plan.days.length) throw new Error("days が空");
  return plan;
}

function newsBlock(sources: Source[]) {
  if (!sources.length) return "";
  const lines = sources.map((s) => `[${s.id}] ${s.title}（${s.publisher || s.collection}${s.date ? "、" + s.date : ""}）\n${s.text}`);
  return `\n\n参考資料：Redpineで取得したライセンス済みの最新記事。
${lines.join("\n\n")}

参考資料の使い方:
- 旅程に影響する記事（運休・欠航・減便・工事・通行止め・イベントによる混雑や宿の高騰・料金改定など）があれば旅程に反映し、aiWarnings・tips・該当する legs の note の文末に [R1] のように番号を付ける。
- 旅行の日付や場所に関係しない記事は無視し、番号を付けない。記事に書かれていないことを記事の番号付きで書かない。
- 記事が古く、旅行の日には状況が変わっているかもしれないときは、そう書く。`;
}

const citedIds = (plan: any) => new Set([...JSON.stringify(plan).matchAll(/\[(R\d+)\]/g)].map((m) => m[1]));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const { prompt, form, kind } = await req.json();
    if (typeof prompt !== "string" || prompt.length < 20 || prompt.length > 60000) return json({ error: "依頼文が空か長すぎます" }, 400);

    const { sources, info } = await findNews((form || {}) as Form);
    const system = "あなたは日本国内旅行の段取りを組む担当です。指定された形式のJSONだけを返します。説明文やコードブロックは付けません。";
    const user = prompt + newsBlock(sources);

    let plan;
    try {
      plan = parsePlan(await askAI(system, user));
    } catch (e) {
      if ((e as Error).message.startsWith("AI")) throw e;
      // JSONが崩れていたら1回だけやり直す
      plan = parsePlan(await askAI(system, user + "\n\n前回の出力はJSONとして読めませんでした。形式どおりのJSONだけを返してください。"));
    }

    const ids = citedIds(plan);
    plan.sources = sources.filter((s) => ids.has(s.id));
    plan.redpine = { ...info, found: sources.length, note: info.note || (sources.length && !plan.sources.length ? `Redpineで記事を${sources.length}件調べましたが、この旅程に影響するものはありませんでした。` : "") };
    return json({ plan, kind: kind || "plan" });
  } catch (e) {
    return json({ error: (e as Error).message || "不明なエラー" }, 500);
  }
});
