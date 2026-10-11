// Share and search previews drawn from a page's tags. Pure: a model from metadata, then h.html markup.
// Approximations of each platform's layout — no brand assets.

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const THUMB = /^data:image\/(?:webp|png|jpeg);base64,/;
const cut = (s, n) => {
  const t = Array.from(String(s ?? '').replace(/\s+/g, ' ').trim());
  return t.length > n ? `${t.slice(0, n - 1).join('').trimEnd()}…` : t.join('');
};

export function previewModel(d = {}, { target = {}, ogImage = null, interactive = true } = {}) {
  const og = d.og || {};
  const tw = d.twitter || {};
  const page = target.finalUrl || target.url || d.url || '';
  const abs = (u, base = page) => { try { return u ? new URL(u, base || undefined).href : ''; } catch { return ''; } };
  const url = abs(d.canonical) || page;
  let host = target.host || '';
  try { host = new URL(url || page).host || host; } catch { /* keep */ }
  const ogImg = abs(og['og:image']);
  const twImg = abs(tw['twitter:image']) || ogImg;
  const src = (u) => (typeof ogImage?.thumb === 'string' && THUMB.test(ogImage.thumb) && u && u === ogImg ? ogImage.thumb : interactive && /^https?:\/\//.test(u) ? u : '');
  let path = '';
  try { path = new URL(url).pathname.split('/').filter(Boolean).join(' › '); } catch { /* none */ }
  return {
    host, url, path,
    siteName: og['og:site_name'] || host,
    themeColor: HEX.test(String(d.themeColor || '')) ? d.themeColor : '',
    google: { title: d.title || og['og:title'] || host, description: d.description || og['og:description'] || '' },
    og: { title: og['og:title'] || d.title || host, description: og['og:description'] || d.description || '', image: src(ogImg) },
    x: {
      card: tw['twitter:card'] === 'summary_large_image' ? 'summary_large_image' : 'summary',
      title: tw['twitter:title'] || og['og:title'] || d.title || host,
      description: tw['twitter:description'] || og['og:description'] || d.description || '',
      image: src(twImg),
    },
  };
}

export function renderPreviews(m, h) {
  const img = (s, cls = '') => (s ? h.html`<img class="pv-img ${cls}" src="${s}" alt="" loading="lazy">` : h.html`<div class="pv-img pv-noimg ${cls}">no image</div>`);
  const card = (name, body, style = '') => h.html`<figure class="pv-card pv-${name.toLowerCase()}"${style ? h.raw(` style="${style}"`) : ''}><figcaption>${name}</figcaption>${body}</figure>`;
  const google = card('Google', h.html`<div class="pv-site"><span class="pv-fav">${(m.siteName || '?').slice(0, 1).toUpperCase()}</span><span><b>${m.siteName}</b><small>${m.host}${m.path ? ` › ${m.path}` : ''}</small></span></div>
    <div class="pv-gtitle">${cut(m.google.title, 60)}</div><p>${cut(m.google.description, 155)}</p>`);
  const x = m.x.card === 'summary_large_image'
    ? card('X', h.html`${img(m.x.image, 'pv-wide')}<div class="pv-body"><small>${m.host}</small><b>${cut(m.x.title, 70)}</b></div>`)
    : card('X', h.html`<div class="pv-row">${img(m.x.image, 'pv-square')}<div class="pv-body"><small>${m.host}</small><b>${cut(m.x.title, 70)}</b><p>${cut(m.x.description, 125)}</p></div></div>`);
  const facebook = card('Facebook', h.html`${img(m.og.image, 'pv-wide')}<div class="pv-body"><small>${m.host.toUpperCase()}</small><b>${cut(m.og.title, 88)}</b><p>${cut(m.og.description, 110)}</p></div>`);
  const linkedin = card('LinkedIn', h.html`${img(m.og.image, 'pv-wide')}<div class="pv-body"><b>${cut(m.og.title, 70)}</b><small>${m.host}</small></div>`);
  const slack = card('Slack', h.html`<div class="pv-body pv-slack"><small><b>${m.siteName}</b></small><a class="pv-link">${m.og.title}</a><p>${cut(m.og.description, 150)}</p>${img(m.og.image, 'pv-small')}</div>`);
  const discord = card('Discord', h.html`<div class="pv-body"><small>${m.siteName}</small><a class="pv-link">${m.og.title}</a><p>${cut(m.og.description, 350)}</p>${img(m.og.image, 'pv-wide')}</div>`,
    HEX.test(String(m.themeColor || '')) ? `border-left-color:${m.themeColor}` : '');
  const bluesky = card('Bluesky', h.html`${img(m.og.image, 'pv-wide')}<div class="pv-body"><b>${cut(m.og.title, 70)}</b><p>${cut(m.og.description, 150)}</p><small>${m.host}</small></div>`);
  return h.html`${google}${x}${facebook}${linkedin}${slack}${discord}${bluesky}`;
}
