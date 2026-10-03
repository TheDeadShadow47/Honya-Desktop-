// Local stand-in for royalroad.com, shaped after what the REAL royalroad plugin bundle parses
// (htmlparser2 state machine: fiction-list-item/figure, h1, /profile/ link, label-sm status, window.chapters script, chapter-content).
// SYNTHETIC: validates bundle+shim+app pipeline, not the live site's current markup.
const http = require('node:http');
const NOVELS = [
  { id: 21220, slug: 'mother-of-learning', title: 'Mother of Learning', author: 'nobody103', status: 'COMPLETED', n: 12 },
  { id: 36049, slug: 'the-wandering-inn', title: 'The Wandering Inn', author: 'pirateaba', status: 'ONGOING', n: 5 },
  { id: 8894, slug: 'the-primal-hunter', title: 'The Primal Hunter', author: 'Zogarth', status: 'ONGOING', n: 3 },
];
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const list = (items) => `<html><body>${items.map((n) => `<div class="fiction-list-item row"><figure class="col-sm-2"><a href="/fiction/${n.id}/${n.slug}"><img src="/covers/${n.id}.jpg" alt="${esc(n.title)}"></a></figure><h2 class="fiction-title"><a href="/fiction/${n.id}/${n.slug}">${esc(n.title)}</a></h2></div>`).join('')}</body></html>`;
const chapters = (n) => Array.from({ length: n.n }, (_, i) => ({ id: n.id * 100 + i, volumeId: null, title: `Chapter ${i + 1}: ${i === 0 ? 'Good Morning Brother' : 'Part ' + (i + 1)}`, date: `2024-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`, order: i + 1, url: `/fiction/${n.id}/${n.slug}/chapter/${n.id * 100 + i}/chapter-${i + 1}` }));
const novelPage = (n) => `<html><body><div class="fic-header"><img class="thumbnail" src="/covers/${n.id}.jpg"><h1>${esc(n.title)}</h1><h4><span>by </span><a href="/profile/1">${esc(n.author)}</a></h4>
<span class="label label-default label-sm bg-blue-hoki">Web Novel</span><span class="label label-default label-sm bg-blue-hoki">${n.status}</span>
<span class="tags"><a href="/fictions/search?tagsAdd=fantasy">Fantasy</a><a href="/fictions/search?tagsAdd=litrpg">LitRPG</a></span></div>
<div class="description"><p>The story of ${esc(n.title)}: a synthetic summary &amp; test.</p><p>Second paragraph.</p></div>
<script>window.chapters = ${JSON.stringify(chapters(n))};window.volumes = [];</script></body></html>`;
const chapterPage = (n, i) => `<html><body><div class="chapter-content"><p>It was the morning of day ${i} in ${esc(n.title)}.</p><p>"Wake up," said the voice — “smart quotes” &amp; <em>emphasis</em>.</p><p>The third paragraph ends chapter ${i}.</p></div></body></html>`;


// ---- Madara-style site (what ~75 real plugins scrape): shaped after the real BoxNovel/Madara bundle's selectors.
const MN = [
  { slug: 'lord-of-the-mysteries', title: 'Lord of the Mysteries', author: 'Cuttlefish That Loves Diving', status: 'OnGoing', genres: ['Fantasy', 'Mystery'], n: 4 },
  { slug: 'reverend-insanity', title: 'Reverend Insanity', author: 'Gu Zhen Ren', status: 'Completed', genres: ['Xianxia'], n: 3 },
];
const HOST = 'https://novelnice.com';
const mList = (items) => `<html><head><title>Search</title></head><body>${items.map((n) => `<div class="page-item-detail"><div class="item-thumb"><a href="${HOST}/novel/${n.slug}/"><img data-src="${HOST}/c/${n.slug}.jpg" alt=""></a></div><div class="post-title font-title"><h3 class="h5"><span class="manga-title-badges hot">HOT</span><a href="${HOST}/novel/${n.slug}/">${esc(n.title)}</a></h3></div></div>`).join('')}</body></html>`;
const mNovel = (n) => `<html><head><title>${esc(n.title)}</title></head><body><div class="post-title"><h1><span class="manga-title-badges">NEW</span> ${esc(n.title)}</h1></div>
<div class="summary_image"><a href="#"><img data-src="${HOST}/c/${n.slug}.jpg"></a></div>
<div class="post-content"><div class="post-content_item"><div class="summary-heading"><h5>Author(s)</h5></div><div class="summary-content"><a href="/a">${esc(n.author)}</a></div></div>
<div class="post-content_item"><div class="summary-heading"><h5>Genre(s)</h5></div><div class="summary-content">${n.genres.map((g) => `<a href="/g/${g}">${g}</a>`).join(', ')}</div></div>
<div class="post-content_item"><div class="summary-heading"><h5>Status</h5></div><div class="summary-content">${n.status}</div></div></div>
<div class="manga-summary"><p>Synthetic madara summary for ${esc(n.title)}.</p><p>Second para.</p></div></body></html>`;
const mChapters = (n) => `<ul class="main version-chap">${Array.from({ length: n.n }, (_, i) => n.n - i).map((i) => `<li class="wp-manga-chapter"><a href="${HOST}/novel/${n.slug}/chapter-${i}/">Chapter ${i}</a><span class="chapter-release-date"><i>${i % 2 ? 'March ' + i + ', 2024' : i + ' days ago'}</i></span></li>`).join('')}</ul>`;
const mChapter = (n, i) => `<html><body><div class="reading-content"><div class="text-left"><p>Madara chapter ${i} of ${esc(n.title)}.</p><p>Line one<br>line two &amp; “quotes”.</p></div></div></body></html>`;
function madara(u, method) {
  const p = u.pathname.replace(/^\/\//, '/');
  if (p.startsWith('/page/')) { const q = (u.searchParams.get('s') || '').toLowerCase(); return mList(q ? MN.filter((n) => n.title.toLowerCase().includes(q)) : MN); }
  const ajax = p.match(/^\/novel\/([^/]+)\/ajax\/chapters\/$/); if (ajax && method === 'POST') { const n = MN.find((x) => x.slug === ajax[1]); return n && mChapters(n); }
  const ch = p.match(/^\/novel\/([^/]+)\/chapter-(\d+)\/$/); if (ch) { const n = MN.find((x) => x.slug === ch[1]); return n && mChapter(n, +ch[2]); }
  const no = p.match(/^\/novel\/([^/]+)\/$/); if (no) { const n = MN.find((x) => x.slug === no[1]); return n && mNovel(n); }
  return null;
}

function start(port = 0) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url.startsWith('//') ? 'http://x' + req.url : req.url, 'http://x');
    const m = madara(u, req.method);
    if (m) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(m); }
    let body = '<html><body>404</body></html>', status = 404;
    const ch = u.pathname.match(/^\/fiction\/(\d+)\/chapter\/(\d+)/);
    const no = u.pathname.match(/^\/fiction\/(\d+)\/?$/);
    if (u.pathname.startsWith('/fictions/')) {
      const q = (u.searchParams.get('title') || '').toLowerCase();
      body = list(q ? NOVELS.filter((n) => n.title.toLowerCase().includes(q)) : NOVELS); status = 200;
    } else if (ch) { const n = NOVELS.find((x) => x.id === +ch[1]); if (n) { body = chapterPage(n, +ch[2] - n.id * 100 + 1); status = 200; } }
    else if (no) { const n = NOVELS.find((x) => x.id === +no[1]); if (n) { body = novelPage(n); status = 200; } }
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }); res.end(body);
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r(server)));
}
module.exports = { start, NOVELS, MN };
if (require.main === module) start(+process.env.PORT || 0).then((s) => console.log('fixture site on', s.address().port));
