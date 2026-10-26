// Wallet-scoped pagination. Never follow an upstream URL with our API credentials: extract the cursor only
// after checking its host and wallet path, then call the registered route again.
const error = (r) => new Error(`upstream ${r.status}`);
const stop = (reason, checked, total) => ({ status: "truncated", reason, checked, ...(total != null && { total }) });
export async function walletPositions(ctx, id, params, { maxPages = 20, budgetMs = 25000 } = {}) {
  const until = Date.now() + budgetMs, data = [], seen = new Set(), cursors = new Set();
  let after, pages = 0;
  for (; pages < maxPages; pages++) {
    let r;
    try { r = await ctx.call(id, { ...params, ...(after && { after }) }); }
    catch (e) { if (!pages) throw e; return { data, coverage: stop(String(e.error || e.message || e), data.length) }; }
    if (!r.ok || !Array.isArray(r.data?.data)) {
      if (!pages) throw error(r);
      return { data, coverage: stop(`page ${pages + 1} failed (upstream ${r.status})`, data.length) };
    }
    for (const row of r.data.data) {
      const key = row.id ?? JSON.stringify(row);
      if (!seen.has(key)) { seen.add(key); data.push(row); }
    }
    const next = r.data.links?.next?.href || r.data.links?.next;
    if (!next) return { data, coverage: { status: "complete", checked: data.length, pages: pages + 1 } };
    let url;
    try { url = new URL(next); } catch { return { data, coverage: stop("invalid next-page link", data.length) }; }
    const path = `/v1/wallets/${params.address.toLowerCase()}/positions`;
    if (url.origin !== "https://api.zerion.io" || url.pathname.toLowerCase().replace(/\/$/, "") !== path) return { data, coverage: stop("next-page link is outside this wallet", data.length) };
    after = url.searchParams.get("page[after]");
    if (!after || cursors.has(after)) return { data, coverage: stop("missing or repeated page cursor", data.length) };
    cursors.add(after);
    if (Date.now() >= until) return { data, coverage: stop("portfolio page time budget reached", data.length) };
  }
  return { data, coverage: stop(`portfolio page limit (${maxPages}) reached`, data.length) };
}

export async function walletAssets(ctx, owner, { maxPages = 20, limit = 1000, budgetMs = 25000 } = {}) {
  const until = Date.now() + budgetMs, items = [], seen = new Set();
  let first, total;
  for (let page = 1; page <= maxPages; page++) {
    let r;
    try { r = await ctx.call("sol.assets", { owner, page: String(page), limit: String(limit) }); }
    catch (e) { if (!first) throw e; return { result: { ...first, items }, coverage: stop(String(e.error || e.message || e), items.length, total) }; }
    const d = r.ok && !r.data?.error ? r.data?.result : null;
    if (!Array.isArray(d?.items)) {
      if (!first) throw error(r);
      return { result: { ...first, items }, coverage: stop(`asset page ${page} failed (upstream ${r.status})`, items.length, total) };
    }
    first ||= d;
    total = d.total != null && Number.isFinite(Number(d.total)) ? Number(d.total) : null;
    let added = 0;
    for (const row of d.items) if (!seen.has(row.id)) { seen.add(row.id); items.push(row); added++; }
    if (!d.items.length || (total != null && items.length >= total) || (total == null && d.items.length < limit)) {
      return { result: { ...first, items }, coverage: { status: "complete", checked: items.length, ...(total != null && { total }), pages: page } };
    }
    if (!added || Date.now() >= until || page === maxPages) return { result: { ...first, items }, coverage: stop(!added ? "asset page repeated" : "asset page budget reached", items.length, total) };
  }
}

export async function mintInformation(ctx, mints, { budgetMs = 25000 } = {}) {
  const list = [...new Set(mints)], items = [], until = Date.now() + budgetMs, errors = [];
  let checked = 0;
  for (let i = 0; i < list.length; i += 100) {
    const part = list.slice(i, i + 100);
    try {
      const r = await ctx.call("token.jup_info", { query: part.join(",") });
      if (!r.ok || !Array.isArray(r.data)) throw error(r);
      items.push(...r.data); checked += part.length;
    } catch (e) { errors.push(String(e.error || e.message || e).slice(0, 100)); }
    if (Date.now() >= until) break;
  }
  return { items, coverage: { status: checked === list.length ? "complete" : "truncated", checked, total: list.length,
    ...(checked < list.length && { reason: errors.length ? errors.join("; ") : "token information time budget reached" }) } };
}
